// Детермінований мердж схваленого PR без виклику LLM (eshkil/agent-flow#42).
// Повторює всі 4 умови гейту з plugin/skills/merge/SKILL.md чистим Node.js:
//   1. Стан OPEN, не draft, без конфліктів (з ретраями на mergeable=null).
//   2. Лейбл ai:reviewed і жодних комітів / force-push після нього.
//   3. Approve людини з правом запису на поточному headSha або валідне
//      схвалення в Kando з довіреного контексту запуску на точному headSha.
//   4. Зелені перевірки CI (ігноруючи власний job за GITHUB_RUN_ID).
// За будь-якого виходу гарантовано знімає ai:in-progress з PR.

const fs = require('node:fs');
const { paths } = require('./kando');
const { writeFailure } = require('./failure');

const MERGEABLE_RETRIES = 3;
const MERGEABLE_RETRY_MS = 10_000;
const WRITE_PERMS = new Set(['admin', 'maintain', 'write']);
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const CONTEXT_HEADER = '## Контекст запуску (диспетчер agent-flow)';
const KANDO_APPROVAL_RE = /^- Схвалення в Kando: @([A-Za-z0-9-]+) на коміті ([0-9a-fA-F]+)\s*$/m;
const CLOSING_ISSUE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

function recordFailure(env, report) {
  try { writeFailure(env, report); } catch (_) { /* не заважаємо повернути помилку */ }
}

function isProtectedBranch(branch, baseRef) {
  if (!branch) return true;
  if (baseRef && branch === baseRef) return true;
  if (branch === 'kando-attachments') return true;
  return /^ai\/\d+-spec-mockup$/.test(branch);
}

// Схвалення в Kando береться ЛИШЕ з явного поля /start або з блоку «Контекст запуску»
// у промпті від диспетчера — ніколи з коментарів чи рев'ю GitHub.
function parseKandoApproval(prompt, approvalJson) {
  if (approvalJson) {
    try {
      const parsed = typeof approvalJson === 'string' ? JSON.parse(approvalJson) : approvalJson;
      if (parsed && typeof parsed.login === 'string' && typeof parsed.sha === 'string' && parsed.login && parsed.sha) {
        return { login: parsed.login.trim(), sha: parsed.sha.trim() };
      }
    } catch { /* невалідний JSON — ігноруємо */ }
  }
  const text = String(prompt || '');
  const idx = text.indexOf(CONTEXT_HEADER);
  if (idx === -1) return null;
  const match = KANDO_APPROVAL_RE.exec(text.slice(idx));
  return match ? { login: match[1], sha: match[2] } : null;
}

function parseClosingIssuesFromBody(body) {
  const out = [];
  for (const m of String(body || '').matchAll(CLOSING_ISSUE_RE)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

function isOwnRunUrl(url, runId) {
  if (!runId || !url) return false;
  const s = String(url);
  const needle = `/actions/runs/${runId}`;
  const i = s.indexOf(needle);
  if (i === -1) return false;
  const next = s[i + needle.length];
  return next === undefined || next === '/' || next === '?' || next === '#';
}

function readToken(env) {
  return fs.readFileSync(paths(env).token, 'utf8').trim();
}

function makeClient({ env, fetchImpl = fetch }) {
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

  async function req(urlOrPath, { method = 'GET', body, allowStatus = [] } = {}) {
    const token = readToken(env);
    const url = /^https?:\/\//i.test(urlOrPath) ? urlOrPath : `${api}${urlOrPath}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'kando-agent-flow-runner',
    };
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(url, init);
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok && !allowStatus.includes(res.status)) {
      const msg = (data && typeof data === 'object' && data.message) ? data.message : (text || `HTTP ${res.status}`);
      const err = new Error(`GitHub ${method} ${urlOrPath} → ${res.status}: ${msg}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return { status: res.status, ok: res.ok, data, headers: res.headers };
  }

  async function paginate(urlPath, extract = d => (Array.isArray(d) ? d : [])) {
    const all = [];
    let next = urlPath;
    for (let page = 0; page < 50 && next; page++) {
      const res = await req(next);
      all.push(...extract(res.data));
      const link = res.headers?.get?.('link') || '';
      const m = /<([^>]+)>;\s*rel="next"/.exec(link);
      next = m ? m[1] : null;
    }
    return all;
  }

  return { req, paginate };
}

async function fetchPrWithMergeable(gh, repo, prNumber, { sleep, retryMs, maxRetries }) {
  let pr = (await gh.req(`/repos/${repo}/pulls/${prNumber}`)).data;
  for (let i = 0; i < maxRetries && pr.state === 'open' && !pr.draft && pr.mergeable == null; i++) {
    await sleep(retryMs);
    pr = (await gh.req(`/repos/${repo}/pulls/${prNumber}`)).data;
  }
  return pr;
}

async function hasWritePermission(gh, repo, login, cache) {
  const key = String(login || '').toLowerCase();
  if (!key) return false;
  if (cache.has(key)) return cache.get(key);
  const res = await gh.req(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, { allowStatus: [404] });
  const ok = res.ok && WRITE_PERMS.has(res.data?.permission);
  cache.set(key, ok);
  return ok;
}

function checkTimelineReviewed(pr, timeline) {
  const hasLabel = (pr.labels || []).some(l => (l.name ?? l) === 'ai:reviewed');
  if (!hasLabel) return 'немає лейбла `ai:reviewed` — спершу потрібне AI-рев\'ю';

  let lastReviewedAt = 0;
  let lastCommitAt = 0;
  for (const e of timeline) {
    if (e.event === 'labeled' && e.label?.name === 'ai:reviewed') {
      const t = Date.parse(e.created_at);
      if (Number.isFinite(t) && t > lastReviewedAt) lastReviewedAt = t;
    } else if (e.event === 'committed') {
      const t = Date.parse(e.committer?.date || e.author?.date || e.created_at);
      if (Number.isFinite(t) && t > lastCommitAt) lastCommitAt = t;
    } else if (e.event === 'head_ref_force_pushed') {
      const t = Date.parse(e.created_at);
      if (Number.isFinite(t) && t > lastCommitAt) lastCommitAt = t;
    }
  }
  if (lastCommitAt > 0 && (!lastReviewedAt || lastCommitAt > lastReviewedAt)) {
    return 'після встановлення `ai:reviewed` були нові коміти або force-push — потрібне повторне рев\'ю';
  }
  return null;
}

async function checkHumanApproval(gh, repo, headSha, reviews, kandoApproval, permCache) {
  // Для кожного користувача беремо його останній фінальний відгук (без COMMENTED і PENDING).
  const latestByUser = new Map();
  for (const r of reviews) {
    if (!r?.user?.login || r.user.type === 'Bot') continue;
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    const key = r.user.login.toLowerCase();
    const prev = latestByUser.get(key);
    const t = Date.parse(r.submitted_at) || 0;
    const prevT = prev ? (Date.parse(prev.submitted_at) || 0) : -1;
    if (!prev || t >= prevT) latestByUser.set(key, r);
  }
  for (const r of latestByUser.values()) {
    if (r.state === 'APPROVED' && r.commit_id === headSha) {
      if (await hasWritePermission(gh, repo, r.user.login, permCache)) return null;
    }
  }
  if (kandoApproval && kandoApproval.sha === headSha) {
    if (await hasWritePermission(gh, repo, kandoApproval.login, permCache)) return null;
  }
  return 'немає Approve від людини з правом запису на поточному коміті';
}

function checkCiStatus(checkRuns, commitStatuses, runId) {
  const reasons = [];
  const failed = [];
  const pending = [];

  // Ключ включає app.id і check_suite.id, щоб дві різні перевірки з однаковою назвою
  // (`test`/`build` із різних workflow або App) не перезаписували одна одну.
  const latestRuns = new Map();
  for (const cr of checkRuns) {
    if (isOwnRunUrl(cr.html_url, runId) || isOwnRunUrl(cr.details_url, runId)) continue;
    const key = `${cr.app?.id ?? ''}:${cr.check_suite?.id ?? ''}:${cr.name}`;
    const prev = latestRuns.get(key);
    if (!prev || Number(cr.id || 0) >= Number(prev.id || 0)) latestRuns.set(key, cr);
  }
  for (const cr of latestRuns.values()) {
    if (cr.status !== 'completed') pending.push(cr.name);
    else if (!OK_CONCLUSIONS.has(cr.conclusion)) failed.push(`${cr.name} (${cr.conclusion || 'failure'})`);
  }

  // Commit statuses: /commits/{ref}/statuses повертає записи від новіших до старіших — беремо перший на context.
  const seenContexts = new Set();
  for (const st of commitStatuses) {
    if (!st?.context || seenContexts.has(st.context)) continue;
    seenContexts.add(st.context);
    if (isOwnRunUrl(st.target_url, runId)) continue;
    if (st.state === 'pending') pending.push(st.context);
    else if (st.state === 'failure' || st.state === 'error') failed.push(`${st.context} (${st.state})`);
  }

  if (failed.length) reasons.push(`перевірки CI не пройшли: ${failed.join(', ')}`);
  if (pending.length) reasons.push(`перевірки CI ще тривають: ${pending.join(', ')}`);
  return reasons;
}

async function resolveClosingIssues(gh, repo, prNumber, prBody, issueEnv) {
  const nums = new Set();
  const fromEnv = Number(issueEnv);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv !== prNumber) nums.add(fromEnv);

  // Основне джерело — GraphQL closingIssuesReferences лише з цього репозиторію.
  // Парсинг тіла PR використовується лише як fallback при збої GraphQL.
  let gqlOk = false;
  try {
    const [owner, name] = repo.split('/');
    const res = await gh.req('/graphql', {
      method: 'POST',
      body: {
        query: 'query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){closingIssuesReferences(first:50){nodes{number repository{nameWithOwner}}}}}}',
        variables: { owner, name, pr: prNumber },
      },
      allowStatus: [400, 403, 404],
    });
    const nodes = res.data?.data?.repository?.pullRequest?.closingIssuesReferences?.nodes;
    if (res.ok && Array.isArray(nodes)) {
      gqlOk = true;
      for (const node of nodes) {
        const nodeRepo = node?.repository?.nameWithOwner;
        if (nodeRepo && nodeRepo.toLowerCase() !== repo.toLowerCase()) continue;
        const n = Number(node?.number);
        if (Number.isInteger(n) && n > 0 && n !== prNumber) nums.add(n);
      }
    }
  } catch { /* fallback нижче */ }

  if (!gqlOk) {
    for (const n of parseClosingIssuesFromBody(prBody)) {
      if (n !== prNumber) nums.add(n);
    }
  }

  return [...nums];
}

async function runMerge({
  env,
  fetchImpl = fetch,
  sleep = defaultSleep,
  retryMs = MERGEABLE_RETRY_MS,
  maxRetries = MERGEABLE_RETRIES,
  log = console,
}) {
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  const prNumber = Number(env.PR);
  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    const msg = `merge: некоректні параметри запуску (repo=${repo || '—'}, PR=${env.PR || '—'})`;
    recordFailure(env, { stage: 'merge', command: null, exit_code: 1, tail: [msg] });
    throw new Error(msg);
  }

  const gh = makeClient({ env, fetchImpl });
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  const removeInProgress = async () => {
    try {
      await gh.req(`/repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent('ai:in-progress')}`, {
        method: 'DELETE',
        allowStatus: [404],
      });
      return true;
    } catch (e) {
      log.log(`merge: не вдалося зняти ai:in-progress з PR #${prNumber}: ${e.message}`);
      return false;
    }
  };

  await gh.req(`/repos/${repo}/issues/${prNumber}/labels`, {
    method: 'POST',
    body: { labels: ['ai:in-progress'] },
  });

  let labelRemoved = false;
  try {
    const pr = await fetchPrWithMergeable(gh, repo, prNumber, { sleep, retryMs, maxRetries });
    const headSha = pr.head?.sha;
    const headRef = pr.head?.ref;
    const baseRef = pr.base?.ref;

    const unmet = [];
    if (pr.state !== 'open') unmet.push(`PR не відкритий (стан: ${pr.state})`);
    if (pr.draft) unmet.push('PR у статусі draft');
    if (pr.state === 'open' && !pr.draft) {
      if (pr.mergeable == null) unmet.push('не вдалося визначити конфлікти (`mergeable=unknown`)');
      else if (pr.mergeable === false || pr.mergeable_state === 'dirty') unmet.push('є конфлікти з базовою гілкою');
    }

    const [timeline, reviews, checkRuns, commitStatuses] = await Promise.all([
      gh.paginate(`/repos/${repo}/issues/${prNumber}/timeline?per_page=100`),
      gh.paginate(`/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`),
      headSha ? gh.paginate(`/repos/${repo}/commits/${headSha}/check-runs?filter=latest&per_page=100`, d => d?.check_runs || []) : [],
      headSha ? gh.paginate(`/repos/${repo}/commits/${headSha}/statuses?per_page=100`) : [],
    ]);

    const reviewErr = checkTimelineReviewed(pr, timeline);
    if (reviewErr) unmet.push(reviewErr);

    const kandoApproval = parseKandoApproval(env.KANDO_PROMPT, env.KANDO_APPROVAL);
    const permCache = new Map();
    const approvalErr = await checkHumanApproval(gh, repo, headSha, reviews, kandoApproval, permCache);
    if (approvalErr) unmet.push(approvalErr);

    unmet.push(...checkCiStatus(checkRuns, commitStatuses, runId));

    if (unmet.length) {
      const body = [
        '## ⛔ Мердж не виконано: гейт не пройдено',
        '',
        ...unmet.map(r => `- ${r}`),
        '',
        '<sub>🤖 Автоматичний мердж</sub>',
      ].join('\n');
      await gh.req(`/repos/${repo}/issues/${prNumber}/comments`, { method: 'POST', body: { body } });
      log.log(`merge: PR #${prNumber} не пройшов гейт (${unmet.length} зауважень)`);
      return { merged: false, refused: true, reasons: unmet };
    }

    // Атомарний squash-мердж із перевіркою sha: новий коміт у гонці зірве мердж із 409.
    try {
      await gh.req(`/repos/${repo}/pulls/${prNumber}/merge`, {
        method: 'PUT',
        body: { merge_method: 'squash', sha: headSha },
      });
    } catch (e) {
      const body = [
        '## ❌ Не вдалося змерджити PR',
        '',
        `Причина: ${e.message}`,
        '',
        '<sub>🤖 Автоматичний мердж</sub>',
      ].join('\n');
      try {
        await gh.req(`/repos/${repo}/issues/${prNumber}/comments`, { method: 'POST', body: { body } });
      } catch { /* помилка коментаря не має приховати причину збою мерджу */ }
      recordFailure(env, { stage: 'merge', command: `PUT /repos/${repo}/pulls/${prNumber}/merge`, exit_code: e.status || 1, tail: [e.message] });
      throw e;
    }

    // Після успішного мерджу побічні збої (видалення гілки, зняття лейбла, закриття issue)
    // лише логуються, щоб не переводити вже змерджений PR у failed.
    const sameRepo = Boolean(pr.head?.repo?.full_name) && pr.head.repo.full_name.toLowerCase() === repo.toLowerCase();
    let deletedBranch = null;
    if (sameRepo && !isProtectedBranch(headRef, baseRef)) {
      try {
        const refPath = `/repos/${repo}/git/refs/heads/${headRef.split('/').map(encodeURIComponent).join('/')}`;
        const del = await gh.req(refPath, { method: 'DELETE', allowStatus: [404, 422] });
        if (del.ok) deletedBranch = headRef;
      } catch (e) {
        log.log(`merge: не вдалося видалити гілку ${headRef}: ${e.message}`);
      }
    }

    // Знімаємо ai:in-progress до закриття issues; при збої finally зробить ще одну спробу.
    labelRemoved = await removeInProgress();

    // Закриваємо пов'язані відкриті issues (не PR) без зайвого підсумкового коментаря.
    const linked = await resolveClosingIssues(gh, repo, prNumber, pr.body, env.ISSUE);
    const closedIssues = [];
    for (const n of linked) {
      try {
        const iss = await gh.req(`/repos/${repo}/issues/${n}`, { allowStatus: [404] });
        if (iss.ok && iss.data?.state === 'open' && !iss.data?.pull_request) {
          await gh.req(`/repos/${repo}/issues/${n}`, {
            method: 'PATCH',
            body: { state: 'closed', state_reason: 'completed' },
          });
          closedIssues.push(n);
        }
      } catch (e) {
        log.log(`merge: не вдалося закрити issue #${n}: ${e.message}`);
      }
    }

    log.log(`merge: PR #${prNumber} змерджено (squash)${deletedBranch ? `, гілку ${deletedBranch} видалено` : ''}${closedIssues.length ? `, закрито #${closedIssues.join(', #')}` : ''}`);
    return { merged: true, refused: false, deletedBranch, closedIssues };
  } finally {
    if (!labelRemoved) await removeInProgress();
  }
}

if (require.main === module) {
  runMerge({ env: process.env }).catch(e => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}

module.exports = {
  runMerge,
  isProtectedBranch,
  parseKandoApproval,
  parseClosingIssuesFromBody,
  isOwnRunUrl,
  checkTimelineReviewed,
  checkHumanApproval,
  checkCiStatus,
};
