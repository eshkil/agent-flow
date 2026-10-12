const { test } = require('node:test');
const assert = require('node:assert');
const { run } = require('../src/main');
const { fakeGithub } = require('./fake-github');

const R = 'eshkil/kando-board';
const lbl = names => names.map(name => ({ name }));
const env = (over = {}) => ({
  GITHUB_REPOSITORY: R, AGENT_LOGIN: 'eshkil-agent[bot]', AGENT_ALLOWED_USERS: 'eshkil',
  AGENT_DRY_RUN: '', RUN_URL: 'https://run/1', ...over,
});
const event = (label, over = {}) => ({
  action: 'labeled', label: { name: label }, sender: { login: 'eshkil', type: 'User' },
  repository: { owner: { login: 'eshkil' } },
  issue: { number: 12, updated_at: '2026-10-10T10:00:00Z' }, ...over,
});

function issueRoutes(labels, comments = []) {
  return {
    [`GET /repos/${R}/issues/12`]: { number: 12, state: 'open', labels: lbl(labels) },
    GRAPHQL: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] } } } },
    [`GET /repos/${R}/issues/12/comments?per_page=100`]: comments,
    [`DELETE /repos/${R}/issues/12/labels/agent%3Ago`]: null,
    [`DELETE /repos/${R}/issues/12/labels/agent%3Arework`]: null,
    [`DELETE /repos/${R}/issues/12/labels/ai%3Afailed`]: null,
    [`DELETE /repos/${R}/issues/12/labels/needs-human`]: null,
    [`DELETE /repos/${R}/issues/12/labels/ai%3Ain-progress`]: null,
    [`POST /repos/${R}/issues/12/labels`]: [],
    [`POST /repos/${R}/issues/12/comments`]: {},
  };
}

function capture() {
  const out = {};
  return { out, setOutput: (k, v) => { out[k] = v; } };
}

test('main: новий issue + agent:go → запуск triage, сигнал знято, agent:running поставлено', async () => {
  const gh = fakeGithub(issueRoutes([]));
  const { out, setOutput } = capture();
  await run({ event: event('agent:go'), env: env(), gh, setOutput });
  assert.equal(out.action, 'run');
  assert.equal(out.skill, 'triage');
  assert.equal(out.lock_numbers, '12');
  assert.match(out.prompt, /agent-flow:triage/);
  const paths = gh.calls.map(c => `${c.method} ${c.path}`);
  assert.ok(paths.includes(`DELETE /repos/${R}/issues/12/labels/agent%3Ago`));
  const lock = gh.calls.find(c => c.method === 'POST' && c.path.endsWith('/labels'));
  assert.deepEqual(lock.body, { labels: ['agent:running'] });
});

test('main: відправник поза allow-list → коментар, без запуску і без блокування', async () => {
  const gh = fakeGithub(issueRoutes([]));
  const { out, setOutput } = capture();
  await run({ event: event('agent:go', { sender: { login: 'stranger', type: 'User' } }), env: env(), gh, setOutput });
  assert.equal(out.action, 'stop');
  assert.equal(out.lock_numbers, undefined);
  const c = gh.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
  assert.match(c.body.body, /немає дозволу/);
});

test('main: agent:running уже стоїть → «агент уже працює»', async () => {
  const gh = fakeGithub(issueRoutes(['agent:running']));
  const { out, setOutput } = capture();
  await run({ event: event('agent:go'), env: env(), gh, setOutput });
  assert.equal(out.action, 'stop');
  const c = gh.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
  assert.match(c.body.body, /уже працює/);
});

test('main: блокування на повʼязаному issue відхиляє сигнал на PR', async () => {
  const routes = {
    [`GET /repos/${R}/issues/40`]: { number: 40, state: 'open', labels: lbl([]), pull_request: {} },
    [`GET /repos/${R}/pulls/40`]: { number: 40, state: 'open', merged: false, draft: false, mergeable: true, head: { sha: 'abc' }, labels: [], body: 'Closes #12' },
    [`GET /repos/${R}/pulls/40/reviews?per_page=100`]: [],
    [`GET /repos/${R}/issues/40/timeline?per_page=100`]: [],
    [`GET /repos/${R}/commits/abc/check-runs?per_page=100`]: { check_runs: [] },
    [`GET /repos/${R}/commits/abc/status`]: { state: 'pending', statuses: [] },
    [`GET /repos/${R}/issues/40/comments?per_page=100`]: [],
    [`GET /repos/${R}/pulls/40/comments?per_page=100`]: [],
    GRAPHQL: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 12 }] } } } },
    [`GET /repos/${R}/issues/12`]: { number: 12, state: 'open', labels: lbl(['agent:running']) },
    [`DELETE /repos/${R}/issues/40/labels/agent%3Ago`]: null,
    [`POST /repos/${R}/issues/40/comments`]: {},
  };
  const gh = fakeGithub(routes);
  const { out, setOutput } = capture();
  const ev = event('agent:go', { issue: undefined, pull_request: { number: 40, updated_at: '2026-10-10T10:00:00Z' } });
  await run({ event: ev, env: env(), gh, setOutput });
  assert.equal(out.action, 'stop');
  const c = gh.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
  assert.match(c.body.body, /уже працює/);
});

test('main: відмова маршрутизатора → коментар із причиною, без блокування', async () => {
  const gh = fakeGithub(issueRoutes(['ai:triaged', 'spec:ready']));
  const { out, setOutput } = capture();
  await run({ event: event('agent:go'), env: env(), gh, setOutput });
  assert.equal(out.action, 'stop');
  assert.equal(out.lock_numbers, undefined);
  const c = gh.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
  assert.match(c.body.body, /Спеку схвалено/);
});

test('main: dry run → коментар «запустив би», без блокування', async () => {
  const gh = fakeGithub(issueRoutes([]));
  const { out, setOutput } = capture();
  await run({ event: event('agent:go'), env: env({ AGENT_DRY_RUN: '1' }), gh, setOutput });
  assert.equal(out.action, 'stop');
  const c = gh.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
  assert.match(c.body.body, /запустив би `triage`/);
  assert.ok(!gh.calls.some(x => x.method === 'POST' && x.path.endsWith('/labels')));
});

test('main: allow-list порожній → дозволено власнику репо', async () => {
  const gh = fakeGithub(issueRoutes([]));
  const { out, setOutput } = capture();
  await run({ event: event('agent:go'), env: env({ AGENT_ALLOWED_USERS: '' }), gh, setOutput });
  assert.equal(out.action, 'run');
});
