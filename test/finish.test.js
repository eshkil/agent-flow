const { test } = require('node:test');
const assert = require('node:assert');
const { finish } = require('../src/finish');
const { fakeGithub } = require('./fake-github');

const R = 'eshkil/kando-board';
const env = over => ({ GITHUB_REPOSITORY: R, LOCK_NUMBERS: '12,40', ROUTE_OUTCOME: 'success', CLAUDE_OUTCOME: 'success', RUN_URL: 'https://run/1', ...over });
const routes = () => ({
  [`DELETE /repos/${R}/issues/12/labels/agent%3Arunning`]: null,
  [`DELETE /repos/${R}/issues/40/labels/agent%3Arunning`]: null,
  [`POST /repos/${R}/issues/12/labels`]: [],
  [`POST /repos/${R}/issues/12/comments`]: {},
});

test('finish: успіх → лише зняти agent:running з усіх номерів', async () => {
  const gh = fakeGithub(routes());
  await finish({ env: env(), gh });
  const calls = gh.calls.map(c => `${c.method} ${c.path}`);
  assert.deepEqual(calls, [
    `DELETE /repos/${R}/issues/12/labels/agent%3Arunning`,
    `DELETE /repos/${R}/issues/40/labels/agent%3Arunning`,
  ]);
});

test('finish: збій Claude → ai:failed і коментар із посиланням на run', async () => {
  const gh = fakeGithub(routes());
  await finish({ env: env({ CLAUDE_OUTCOME: 'failure' }), gh });
  const lbl = gh.calls.find(c => c.method === 'POST' && c.path.endsWith('/labels'));
  assert.deepEqual(lbl.body, { labels: ['ai:failed'] });
  const c = gh.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
  assert.match(c.body.body, /https:\/\/run\/1/);
});

test('finish: таймаут (cancelled) → ai:failed', async () => {
  const gh = fakeGithub(routes());
  await finish({ env: env({ CLAUDE_OUTCOME: 'cancelled' }), gh });
  assert.ok(gh.calls.some(c => c.method === 'POST' && c.path.endsWith('/labels')));
});

test('finish: падіння маршрутизації → ai:failed', async () => {
  const gh = fakeGithub(routes());
  await finish({ env: env({ ROUTE_OUTCOME: 'failure', CLAUDE_OUTCOME: 'skipped' }), gh });
  assert.ok(gh.calls.some(c => c.method === 'POST' && c.path.endsWith('/labels')));
});

test('finish: порожній LOCK_NUMBERS → нічого не робить', async () => {
  const gh = fakeGithub({});
  await finish({ env: env({ LOCK_NUMBERS: '' }), gh });
  assert.equal(gh.calls.length, 0);
});

const httpErr = status => () => { const e = new Error(`HTTP ${status}`); e.status = status; throw e; };

test('finish: 5xx на одному номері не зупиняє решту номерів', async () => {
  const gh = fakeGithub({ ...routes(), [`DELETE /repos/${R}/issues/12/labels/agent%3Arunning`]: httpErr(500) });
  await assert.rejects(finish({ env: env(), gh }));
  assert.ok(gh.calls.some(c => c.method === 'DELETE' && c.path === `/repos/${R}/issues/40/labels/agent%3Arunning`));
});

test('finish: 5xx при знятті лейбла не пропускає ai:failed і коментар', async () => {
  const gh = fakeGithub({ ...routes(), [`DELETE /repos/${R}/issues/12/labels/agent%3Arunning`]: httpErr(500) });
  await assert.rejects(finish({ env: env({ CLAUDE_OUTCOME: 'failure' }), gh }));
  assert.ok(gh.calls.some(c => c.method === 'POST' && c.path === `/repos/${R}/issues/12/labels`));
  assert.ok(gh.calls.some(c => c.method === 'POST' && c.path === `/repos/${R}/issues/12/comments`));
});

test('finish: 404 при знятті лейбла толерується', async () => {
  const gh = fakeGithub({ ...routes(), [`DELETE /repos/${R}/issues/12/labels/agent%3Arunning`]: httpErr(404) });
  await assert.doesNotReject(finish({ env: env(), gh }));
});

test('finish: збій до блокування (LOCK_NUMBERS порожній) → ai:failed і коментар на EVENT_NUMBER', async () => {
  const gh = fakeGithub({
    [`POST /repos/${R}/issues/7/labels`]: [],
    [`POST /repos/${R}/issues/7/comments`]: {},
  });
  await finish({ env: env({ LOCK_NUMBERS: '', EVENT_NUMBER: '7', ROUTE_OUTCOME: 'failure', CLAUDE_OUTCOME: 'skipped' }), gh });
  assert.deepEqual(gh.calls.map(c => `${c.method} ${c.path}`), [
    `POST /repos/${R}/issues/7/labels`, `POST /repos/${R}/issues/7/comments`,
  ]);
  assert.deepEqual(gh.calls[0].body, { labels: ['ai:failed'] });
});

test('finish: порожній LOCK_NUMBERS, але route успішний → нічого', async () => {
  const gh = fakeGithub({});
  await finish({ env: env({ LOCK_NUMBERS: '', EVENT_NUMBER: '7' }), gh });
  assert.equal(gh.calls.length, 0);
});
