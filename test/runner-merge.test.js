const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { paths } = require('../src/runner/kando');
const { failurePath } = require('../src/runner/failure');
const {
  runMerge,
  isProtectedBranch,
  parseKandoApproval,
  parseClosingIssuesFromBody,
  isOwnRunUrl,
} = require('../src/runner/merge');

const SHA = '1111111111111111111111111111111111111111';
const OLD_SHA = '2222222222222222222222222222222222222222';
const REPO = 'acme/app';
const RUN_ID = '987654';
const silent = { log: () => {} };
const noSleep = async () => {};

function setupEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kando-merge-'));
  const env = { RUNNER_TEMP: dir, GITHUB_REPOSITORY: REPO, PR: '10', GITHUB_RUN_ID: RUN_ID, ...extra };
  fs.mkdirSync(paths(env).dir, { recursive: true });
  fs.writeFileSync(paths(env).token, 'ghs_merge_token', { mode: 0o600 });
  return env;
}

const makeRes = (status, data, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  text: async () => (data == null ? '' : typeof data === 'string' ? data : JSON.stringify(data)),
});

function createGithubFake(over = {}) {
  const state = {
    pr: {
      number: 10,
      state: 'open',
      draft: false,
      mergeable: true,
      mergeable_state: 'clean',
      body: 'Fixes #5',
      labels: [{ name: 'ai:reviewed' }],
      head: { sha: SHA, ref: 'ai/5-feature', repo: { full_name: REPO } },
      base: { ref: 'main' },
    },
    prSequence: null,
    timeline: [
      { event: 'committed', committer: { date: '2026-11-26T10:00:00Z' } },
      { event: 'labeled', label: { name: 'ai:reviewed' }, created_at: '2026-11-26T10:05:00Z' },
    ],
    timelinePages: null,
    reviews: [
      { user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: SHA, submitted_at: '2026-11-26T10:06:00Z' },
    ],
    permissions: { alice: 'write', bob: 'admin', viewer: 'read' },
    checkRuns: [
      { id: 1, name: 'tests', status: 'completed', conclusion: 'success', app: { id: 10 }, check_suite: { id: 100 }, html_url: 'https://github.com/acme/app/actions/runs/111/job/1' },
      { id: 2, name: 'agent', status: 'in_progress', conclusion: null, app: { id: 10 }, check_suite: { id: 101 }, html_url: `https://github.com/acme/app/actions/runs/${RUN_ID}/job/2` },
    ],
    statuses: [],
    issues: { 5: { number: 5, state: 'open' } },
    closingRefs: [{ number: 5, repository: { nameWithOwner: REPO } }],
    graphqlStatus: 200,
    mergeStatus: 200,
    mergeBody: { merged: true, sha: 'merged-sha' },
    deleteRefStatus: 204,
    failCloseIssue: null,
    ...over,
  };
  const calls = [];
  let prFetches = 0;

  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const u = new URL(url);
    const p = u.pathname + u.search;
    calls.push({ method, path: p, body, auth: init.headers?.Authorization });

    if (method === 'POST' && p === `/repos/${REPO}/issues/10/labels`) return makeRes(200, []);
    if (method === 'DELETE' && p.startsWith(`/repos/${REPO}/issues/10/labels/`)) return makeRes(200, []);
    if (method === 'GET' && p === `/repos/${REPO}/pulls/10`) {
      const data = state.prSequence ? state.prSequence[Math.min(prFetches++, state.prSequence.length - 1)] : state.pr;
      return makeRes(200, data);
    }
    if (method === 'GET' && p.startsWith(`/repos/${REPO}/issues/10/timeline`)) {
      if (state.timelinePages) {
        const page = Number(u.searchParams.get('page') || '1');
        const nextUrl = page < state.timelinePages.length ? `https://api.github.com/repos/${REPO}/issues/10/timeline?per_page=100&page=${page + 1}` : null;
        return makeRes(200, state.timelinePages[page - 1], nextUrl ? { link: `<${nextUrl}>; rel="next"` } : {});
      }
      return makeRes(200, state.timeline);
    }
    if (method === 'GET' && p.startsWith(`/repos/${REPO}/pulls/10/reviews`)) return makeRes(200, state.reviews);
    if (method === 'GET' && p.startsWith(`/repos/${REPO}/collaborators/`)) {
      const login = decodeURIComponent(p.split('/')[5]);
      if (!(login in state.permissions)) return makeRes(404, { message: 'Not Found' });
      return makeRes(200, { permission: state.permissions[login] });
    }
    if (method === 'GET' && p.startsWith(`/repos/${REPO}/commits/${SHA}/check-runs`)) {
      return makeRes(200, { check_runs: state.checkRuns });
    }
    if (method === 'GET' && p.startsWith(`/repos/${REPO}/commits/${SHA}/statuses`)) {
      return makeRes(200, state.statuses);
    }
    if (method === 'POST' && p === `/repos/${REPO}/issues/10/comments`) return makeRes(201, { id: 1 });
    if (method === 'PUT' && p === `/repos/${REPO}/pulls/10/merge`) return makeRes(state.mergeStatus, state.mergeBody);
    if (method === 'DELETE' && p.startsWith(`/repos/${REPO}/git/refs/heads/`)) {
      return makeRes(state.deleteRefStatus, state.deleteRefStatus >= 400 ? { message: 'Forbidden' } : null);
    }
    if (method === 'POST' && p === '/graphql') {
      if (state.graphqlStatus >= 400) return makeRes(state.graphqlStatus, { message: 'Forbidden' });
      return makeRes(200, {
        data: { repository: { pullRequest: { closingIssuesReferences: { nodes: state.closingRefs } } } },
      });
    }
    const issMatch = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(p);
    if (issMatch) {
      const n = Number(issMatch[1]);
      if (method === 'GET') return state.issues[n] ? makeRes(200, state.issues[n]) : makeRes(404, { message: 'Not Found' });
      if (method === 'PATCH') {
        if (state.failCloseIssue === n) return makeRes(500, { message: 'Internal Error' });
        state.issues[n] = { ...state.issues[n], ...body };
        return makeRes(200, state.issues[n]);
      }
    }
    throw new Error(`несподіваний запит ${method} ${p}`);
  };

  return { state, calls, fetchImpl };
}

// ─── утиліти ─────────────────────────────────────────────────────────────────
test('isProtectedBranch: захищає базову гілку, kando-attachments і ai/<N>-spec-mockup', () => {
  assert.equal(isProtectedBranch('kando-attachments', 'main'), true);
  assert.equal(isProtectedBranch('ai/42-spec-mockup', 'main'), true);
  assert.equal(isProtectedBranch('main', 'main'), true);
  assert.equal(isProtectedBranch('', 'main'), true);
  assert.equal(isProtectedBranch('ai/42-fix-bug', 'main'), false);
  assert.equal(isProtectedBranch('feat/test', 'main'), false);
});

test('parseKandoApproval: бере рядок лише з блоку Контекст запуску або JSON-поля', () => {
  const prompt = [
    'Виконай скіл `agent-flow:merge` для REPO=acme/app PR=10.',
    '',
    '## Контекст запуску (диспетчер agent-flow)',
    `- Схвалення в Kando: @bob на коміті ${SHA}`,
  ].join('\n');
  assert.deepEqual(parseKandoApproval(prompt), { login: 'bob', sha: SHA });
  assert.equal(parseKandoApproval(`- Схвалення в Kando: @bob на коміті ${SHA}`), null);
  assert.deepEqual(parseKandoApproval('', JSON.stringify({ login: 'alice', sha: SHA })), { login: 'alice', sha: SHA });
});

test('parseClosingIssuesFromBody та isOwnRunUrl', () => {
  assert.deepEqual(parseClosingIssuesFromBody('Fixes #5, closes #12, resolved #99'), [5, 12, 99]);
  assert.equal(isOwnRunUrl(`https://github.com/acme/app/actions/runs/${RUN_ID}/job/7`, RUN_ID), true);
  assert.equal(isOwnRunUrl(`https://github.com/acme/app/actions/runs/${RUN_ID}0/job/7`, RUN_ID), false);
});

// ─── щасливий шлях ───────────────────────────────────────────────────────────
test('runMerge: зелений гейт → squash-мердж з sha, видалення гілки, зняття ai:in-progress і закриття issue без коментаря', async () => {
  const env = setupEnv({ ISSUE: '5' });
  const gh = createGithubFake();
  const res = await runMerge({ env, fetchImpl: gh.fetchImpl, sleep: noSleep, log: silent });

  assert.deepEqual(res, { merged: true, refused: false, deletedBranch: 'ai/5-feature', closedIssues: [5] });
  const mergeCall = gh.calls.find(c => c.method === 'PUT' && c.path.endsWith('/merge'));
  assert.deepEqual(mergeCall.body, { merge_method: 'squash', sha: SHA });
  assert.ok(gh.calls.some(c => c.method === 'DELETE' && c.path === `/repos/${REPO}/git/refs/heads/ai/5-feature`));
  assert.ok(gh.calls.some(c => c.method === 'DELETE' && c.path.endsWith('/labels/ai%3Ain-progress')));
  assert.equal(gh.state.issues[5].state, 'closed');
  assert.equal(gh.state.issues[5].state_reason, 'completed');
  assert.equal(gh.calls.filter(c => c.method === 'POST' && c.path.endsWith('/comments')).length, 0);
});

test('runMerge: COMMENTED і PENDING після APPROVED не скасовують схвалення', async () => {
  const gh = createGithubFake({
    reviews: [
      { user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: SHA, submitted_at: '2026-11-26T10:06:00Z' },
      { user: { login: 'alice', type: 'User' }, state: 'COMMENTED', commit_id: SHA, submitted_at: '2026-11-26T10:07:00Z' },
      { user: { login: 'alice', type: 'User' }, state: 'PENDING', commit_id: SHA, submitted_at: '' },
    ],
  });
  const res = await runMerge({ env: setupEnv(), fetchImpl: gh.fetchImpl, sleep: noSleep, log: silent });
  assert.equal(res.merged, true);
});

test('runMerge: kando_approval з Контексту запуску на точному sha пропускає гейт без GitHub-Approve', async () => {
  const prompt = `## Контекст запуску (диспетчер agent-flow)\n- Схвалення в Kando: @bob на коміті ${SHA}`;
  const env = setupEnv({ KANDO_PROMPT: prompt });
  const gh = createGithubFake({ reviews: [] });
  const res = await runMerge({ env, fetchImpl: gh.fetchImpl, sleep: noSleep, log: silent });
  assert.equal(res.merged, true);
});

test('runMerge: kando_approval на іншому sha або від користувача без права запису → відмова', async () => {
  for (const [login, sha] of [['bob', OLD_SHA], ['viewer', SHA]]) {
    const prompt = `## Контекст запуску (диспетчер agent-flow)\n- Схвалення в Kando: @${login} на коміті ${sha}`;
    const env = setupEnv({ KANDO_PROMPT: prompt });
    const gh = createGithubFake({ reviews: [] });
    const res = await runMerge({ env, fetchImpl: gh.fetchImpl, sleep: noSleep, log: silent });
    assert.equal(res.merged, false, `${login}@${sha}`);
    assert.equal(res.refused, true);
    assert.ok(res.reasons.some(r => /Approve/.test(r)));
    assert.ok(gh.calls.some(c => c.method === 'DELETE' && c.path.endsWith('/labels/ai%3Ain-progress')));
  }
});

test('runMerge: пагінація Link у timeline знаходить новіший коміт на 2-й сторінці', async () => {
  const gh = createGithubFake({
    timelinePages: [
      [{ event: 'labeled', label: { name: 'ai:reviewed' }, created_at: '2026-11-26T10:00:00Z' }],
      [{ event: 'head_ref_force_pushed', created_at: '2026-11-26T10:10:00Z' }],
    ],
  });
  const res = await runMerge({ env: setupEnv(), fetchImpl: gh.fetchImpl, sleep: noSleep, log: silent });
  assert.equal(res.merged, false);
  assert.ok(res.reasons.some(r => /force-push/.test(r)));
});

test('runMerge: mergeable=null ретраїться до 3 разів; коли стає true — мерджить; лишається null — відмовляє', async () => {
  const basePr = createGithubFake().state.pr;
  const sleeps = [];
  const ghOk = createGithubFake({
    prSequence: [{ ...basePr, mergeable: null }, { ...basePr, mergeable: null }, { ...basePr, mergeable: true }],
  });
  const ok = await runMerge({ env: setupEnv(), fetchImpl: ghOk.fetchImpl, sleep: async ms => sleeps.push(ms), retryMs: 5, log: silent });
  assert.equal(ok.merged, true);
  assert.deepEqual(sleeps, [5, 5]);

  const ghStuck = createGithubFake({ pr: { ...basePr, mergeable: null } });
  const bad = await runMerge({ env: setupEnv(), fetchImpl: ghStuck.fetchImpl, sleep: noSleep, retryMs: 1, maxRetries: 3, log: silent });
  assert.equal(bad.merged, false);
  assert.equal(bad.refused, true);
  assert.ok(bad.reasons.some(r => /unknown/.test(r)));
});

// ─── відмови гейту по всіх 4 умовах ──────────────────────────────────────────
test('runMerge: відмови гейту (closed, draft, конфлікт, коміт/force-push, старий/чужий Approve, CI check-runs і statuses)', async () => {
  const base = createGithubFake().state.pr;
  const cases = [
    ['closed PR', { pr: { ...base, state: 'closed' } }, /не відкритий/],
    ['draft', { pr: { ...base, draft: true } }, /draft/],
    ['conflict', { pr: { ...base, mergeable: false } }, /конфлікт/],
    ['no ai:reviewed', { pr: { ...base, labels: [] } }, /ai:reviewed/],
    ['commit after review', {
      timeline: [
        { event: 'labeled', label: { name: 'ai:reviewed' }, created_at: '2026-11-26T10:00:00Z' },
        { event: 'committed', committer: { date: '2026-11-26T10:05:00Z' } },
      ],
    }, /нові коміти/],
    ['bot approve ignored', {
      reviews: [{ user: { login: 'kando[bot]', type: 'Bot' }, state: 'APPROVED', commit_id: SHA, submitted_at: '2026-11-26T10:06:00Z' }],
    }, /Approve/],
    ['approve on old SHA', {
      reviews: [{ user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: OLD_SHA, submitted_at: '2026-11-26T10:06:00Z' }],
    }, /Approve/],
    ['approve without write permission', {
      reviews: [{ user: { login: 'viewer', type: 'User' }, state: 'APPROVED', commit_id: SHA, submitted_at: '2026-11-26T10:06:00Z' }],
    }, /Approve/],
    ['changes requested after approve', {
      reviews: [
        { user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: SHA, submitted_at: '2026-11-26T10:06:00Z' },
        { user: { login: 'alice', type: 'User' }, state: 'CHANGES_REQUESTED', commit_id: SHA, submitted_at: '2026-11-26T10:07:00Z' },
      ],
    }, /Approve/],
    ['failing CI check_run', {
      checkRuns: [{ id: 1, name: 'lint', status: 'completed', conclusion: 'failure', app: { id: 10 }, check_suite: { id: 100 }, html_url: 'https://github.com/acme/app/actions/runs/222/job/1' }],
    }, /CI не пройшли.*lint/],
    ['same-name check_run from different workflow: failure not hidden by green', {
      checkRuns: [
        { id: 1, name: 'test', status: 'completed', conclusion: 'failure', app: { id: 10 }, check_suite: { id: 100 }, html_url: 'https://github.com/acme/app/actions/runs/222/job/1' },
        { id: 2, name: 'test', status: 'completed', conclusion: 'success', app: { id: 10 }, check_suite: { id: 200 }, html_url: 'https://github.com/acme/app/actions/runs/333/job/2' },
      ],
    }, /CI не пройшли.*test/],
    ['pending CI check_run', {
      checkRuns: [{ id: 1, name: 'build', status: 'in_progress', conclusion: null, app: { id: 10 }, check_suite: { id: 100 }, html_url: 'https://github.com/acme/app/actions/runs/222/job/1' }],
    }, /CI ще тривають.*build/],
    ['failing commit status', {
      statuses: [{ context: 'deploy/render', state: 'failure', target_url: 'https://render.test/1' }],
    }, /CI не пройшли.*deploy\/render/],
    ['pending commit status', {
      statuses: [{ context: 'deploy/render', state: 'pending', target_url: 'https://render.test/1' }],
    }, /CI ще тривають.*deploy\/render/],
  ];

  for (const [name, over, pattern] of cases) {
    const gh = createGithubFake(over);
    const res = await runMerge({ env: setupEnv(), fetchImpl: gh.fetchImpl, sleep: noSleep, log: silent });
    assert.equal(res.merged, false, name);
    assert.equal(res.refused, true, name);
    assert.ok(res.reasons.some(r => pattern.test(r)), `${name}: ${res.reasons.join('; ')}`);
    assert.equal(gh.calls.filter(c => c.method === 'PUT' && c.path.endsWith('/merge')).length, 0, name);
    assert.equal(gh.calls.filter(c => c.method === 'POST' && c.path.endsWith('/comments')).length, 1, name);
    assert.ok(gh.calls.some(c => c.method === 'DELETE' && c.path.endsWith('/labels/ai%3Ain-progress')), name);
  }
});

// ─── захист гілок, форків та ізоляція збоїв після мерджу ─────────────────────
test('runMerge: не видаляє kando-attachments, чужий форк і видалений форк (head.repo=null)', async () => {
  const base = createGithubFake().state.pr;
  for (const head of [
    { ...base.head, ref: 'kando-attachments' },
    { ...base.head, ref: 'ai/5-feature', repo: { full_name: 'forker/app' } },
    { ...base.head, ref: 'ai/5-feature', repo: null },
  ]) {
    const gh = createGithubFake({ pr: { ...base, head } });
    const res = await runMerge({ env: setupEnv(), fetchImpl: gh.fetchImpl, sleep: noSleep, log: silent });
    assert.equal(res.merged, true);
    assert.equal(res.deletedBranch, null);
    assert.equal(gh.calls.filter(c => c.method === 'DELETE' && c.path.includes('/git/refs/')).length, 0);
  }
});

test('runMerge: GraphQL фільтрує чужі репо, не парсить тіло без збою GraphQL і не закриває PR-и', async () => {
  const base = createGithubFake().state.pr;
  const gh = createGithubFake({
    pr: { ...base, body: 'Fixes #99 (згадка у прикладі)' },
    closingRefs: [
      { number: 5, repository: { nameWithOwner: REPO } },
      { number: 7, repository: { nameWithOwner: 'other/repo' } },
      { number: 8, repository: { nameWithOwner: REPO } },
    ],
    issues: {
      5: { number: 5, state: 'open' },
      7: { number: 7, state: 'open' },
      8: { number: 8, state: 'open', pull_request: { url: 'x' } },
      99: { number: 99, state: 'open' },
    },
  });
  const res = await runMerge({ env: setupEnv(), fetchImpl: gh.fetchImpl, sleep: noSleep, log: silent });
  assert.deepEqual(res.closedIssues, [5]);
  assert.equal(gh.state.issues[5].state, 'closed');
  assert.equal(gh.state.issues[7].state, 'open');
  assert.equal(gh.state.issues[8].state, 'open');
  assert.equal(gh.state.issues[99].state, 'open');
});

test('runMerge: збій видалення гілки або закриття одного issue після PUT /merge не валить запуск і закриває решту', async () => {
  const gh = createGithubFake({
    deleteRefStatus: 403,
    failCloseIssue: 5,
    closingRefs: [
      { number: 5, repository: { nameWithOwner: REPO } },
      { number: 6, repository: { nameWithOwner: REPO } },
    ],
    issues: { 5: { number: 5, state: 'open' }, 6: { number: 6, state: 'open' } },
  });
  const res = await runMerge({ env: setupEnv(), fetchImpl: gh.fetchImpl, sleep: noSleep, log: silent });
  assert.equal(res.merged, true);
  assert.equal(res.deletedBranch, null);
  assert.deepEqual(res.closedIssues, [6]);
  assert.equal(gh.state.issues[6].state, 'closed');
});

test('runMerge: збій PUT /merge → коментар з помилкою, failure.json, ai:in-progress знято, issue лишається відкритим', async () => {
  const env = setupEnv({ ISSUE: '5' });
  const gh = createGithubFake({ mergeStatus: 405, mergeBody: { message: 'Pull Request is not mergeable' } });
  await assert.rejects(runMerge({ env, fetchImpl: gh.fetchImpl, sleep: noSleep, log: silent }), /405/);
  assert.equal(gh.state.issues[5].state, 'open');
  assert.ok(gh.calls.some(c => c.method === 'POST' && c.path.endsWith('/comments')));
  assert.ok(gh.calls.some(c => c.method === 'DELETE' && c.path.endsWith('/labels/ai%3Ain-progress')));
  const saved = JSON.parse(fs.readFileSync(failurePath(env), 'utf8'));
  assert.equal(saved.stage, 'merge');
});

test('action.yml: при skill == merge пропускає files, setup, preflight, claude_install, provider, claude і claude_custom та викликає merge.js', () => {
  const actionYml = fs.readFileSync(path.join(__dirname, '..', 'runner', 'action.yml'), 'utf8');
  const step = id => actionYml.split(/\n    - id: /).find(b => b.startsWith(`${id}\n`));
  for (const id of ['files', 'setup', 'preflight', 'claude_install', 'provider', 'claude', 'claude_custom']) {
    assert.ok(step(id).includes("steps.start.outputs.skill != 'merge'"), `${id} має пропускатись на merge`);
  }
  assert.ok(step('merge').includes("if: steps.start.outputs.skill == 'merge'"));
  assert.ok(step('merge').includes('src/runner/merge.js'));
  assert.ok(step('finish').includes("steps.start.outputs.skill == 'merge' && steps.merge.outcome || (steps.provider.outputs.is_custom == 'true' && steps.claude_custom.outcome || steps.claude.outcome)"));
});
