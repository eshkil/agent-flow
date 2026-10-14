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
    `DELETE /repos/${R}/issues/12/labels/ai%3Ain-progress`,
    `DELETE /repos/${R}/issues/40/labels/ai%3Ain-progress`,
  ]);
});

test('finish: Claude «успішний», але ai:in-progress лишився → зняти, ai:failed і коментар «без результату»', async () => {
  const gh = fakeGithub({ ...routes(), [`DELETE /repos/${R}/issues/12/labels/ai%3Ain-progress`]: [] });
  await finish({ env: env(), gh });
  const lbl = gh.calls.find(c => c.method === 'POST' && c.path === `/repos/${R}/issues/12/labels`);
  assert.deepEqual(lbl.body, { labels: ['ai:failed'] });
  const c = gh.calls.find(x => x.method === 'POST' && x.path === `/repos/${R}/issues/12/comments`);
  assert.match(c.body.body, /без результату/);
  assert.match(c.body.body, /https:\/\/run\/1/);
});

test('finish: ai:in-progress лишився на другому номері → коментар туди ж', async () => {
  const gh = fakeGithub({
    ...routes(),
    [`DELETE /repos/${R}/issues/40/labels/ai%3Ain-progress`]: [],
    [`POST /repos/${R}/issues/40/labels`]: [],
    [`POST /repos/${R}/issues/40/comments`]: {},
  });
  await finish({ env: env(), gh });
  assert.ok(gh.calls.some(c => c.method === 'POST' && c.path === `/repos/${R}/issues/40/comments`));
  assert.ok(!gh.calls.some(c => c.method === 'POST' && c.path === `/repos/${R}/issues/12/comments`));
});

test('finish: збій Claude знімає й завислий ai:in-progress, коментар один', async () => {
  const gh = fakeGithub({ ...routes(), [`DELETE /repos/${R}/issues/12/labels/ai%3Ain-progress`]: [] });
  await finish({ env: env({ CLAUDE_OUTCOME: 'failure' }), gh });
  assert.equal(gh.calls.filter(c => c.method === 'POST' && c.path.endsWith('/comments')).length, 1);
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

// ─── Ліміт Claude і статус для Kando (agent-flow#5) ─────────────────────────
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const execFile = messages => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'af-finish-')), 'claude-execution-output.json');
  fs.writeFileSync(f, JSON.stringify(messages));
  return f;
};
const limitLog = () => execFile([
  { type: 'system', subtype: 'init' },
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1760461200, rateLimitType: 'five_hour' } },
  { type: 'result', subtype: 'success', is_error: true, result: 'You’ve hit your limit · resets 5pm' },
]);
const statusEnv = over => env({ STATUS_URL: 'https://kando/api/github/agent-status', STATUS_SECRET: 's', TIMEZONE: 'Europe/Kyiv', ...over });
const quiet = { warn() {}, log() {} };
const fetchSpy = (res = { ok: true, status: 200 }) => {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, ...opts, json: JSON.parse(opts.body) }); return res; };
  f.calls = calls;
  return f;
};
const outputs = () => { const o = {}; const set = (k, v) => { o[k] = v; }; set.values = o; return set; };

test('finish: ліміт у журналі → коментар «ліміт Claude» з часом відновлення, статус limit', async () => {
  const gh = fakeGithub(routes());
  const fetchImpl = fetchSpy();
  const setOutput = outputs();
  await finish({ env: statusEnv({ CLAUDE_OUTCOME: 'failure', EXECUTION_FILE: limitLog() }), gh, fetchImpl, setOutput, log: quiet });
  const c = gh.calls.find(x => x.method === 'POST' && x.path === `/repos/${R}/issues/12/comments`);
  assert.match(c.body.body, /ліміт Claude, відновлення 14\.10 о 20:00 \(Europe\/Kyiv\)/);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].json.status, 'limit');
  assert.equal(fetchImpl.calls[0].json.repo, R);
  assert.equal(fetchImpl.calls[0].json.until, '2025-10-14T17:00:00.000Z');
  assert.deepEqual(setOutput.values, { limit_reached: 'true', limit_until: '2025-10-14T17:00:00.000Z' });
});

test('finish: ліміт без часу → «ліміт Claude» без часу, статус не шлемо (Kando вимагає until)', async () => {
  const gh = fakeGithub(routes());
  const fetchImpl = fetchSpy();
  const setOutput = outputs();
  const f = execFile([{ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached' }]);
  await finish({ env: statusEnv({ CLAUDE_OUTCOME: 'failure', EXECUTION_FILE: f }), gh, fetchImpl, setOutput, log: quiet });
  const c = gh.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
  assert.match(c.body.body, /Агент не завершив роботу: ліміт Claude\./);
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(setOutput.values, { limit_reached: 'true', limit_until: '' });
});

test('finish: успішний запуск → статус ok', async () => {
  const gh = fakeGithub(routes());
  const fetchImpl = fetchSpy();
  const setOutput = outputs();
  await finish({ env: statusEnv(), gh, fetchImpl, setOutput, log: quiet });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].json.status, 'ok');
  assert.equal(fetchImpl.calls[0].json.until, undefined);
  assert.deepEqual(setOutput.values, { limit_reached: 'false', limit_until: '' });
});

test('finish: звичайний збій → статус не змінюємо, коментар як раніше', async () => {
  const gh = fakeGithub(routes());
  const fetchImpl = fetchSpy();
  const f = execFile([{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }]);
  await finish({ env: statusEnv({ CLAUDE_OUTCOME: 'failure', EXECUTION_FILE: f }), gh, fetchImpl, setOutput: outputs(), log: quiet });
  assert.equal(fetchImpl.calls.length, 0);
  const c = gh.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
  assert.match(c.body.body, /запуск завершився з помилкою/);
});

test('finish: Claude не запускався (skipped) → статус не шлемо', async () => {
  const gh = fakeGithub(routes());
  const fetchImpl = fetchSpy();
  await finish({ env: statusEnv({ ROUTE_OUTCOME: 'failure', CLAUDE_OUTCOME: 'skipped' }), gh, fetchImpl, setOutput: outputs(), log: quiet });
  assert.equal(fetchImpl.calls.length, 0);
});

test('finish: без status_url запиту немає', async () => {
  const gh = fakeGithub(routes());
  const fetchImpl = fetchSpy();
  await finish({ env: env(), gh, fetchImpl, setOutput: outputs(), log: quiet });
  assert.equal(fetchImpl.calls.length, 0);
});

test('finish: недоступний Kando не валить finish і не заважає ai:failed', async () => {
  const gh = fakeGithub(routes());
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  await assert.doesNotReject(finish({ env: statusEnv({ CLAUDE_OUTCOME: 'failure', EXECUTION_FILE: limitLog() }), gh, fetchImpl: boom, setOutput: outputs(), log: quiet }));
  assert.ok(gh.calls.some(c => c.method === 'POST' && c.path === `/repos/${R}/issues/12/labels`));
});

test('finish: журналу нема (EXECUTION_FILE порожній) → звичайний збій', async () => {
  const gh = fakeGithub(routes());
  await finish({ env: statusEnv({ CLAUDE_OUTCOME: 'failure', EXECUTION_FILE: '' }), gh, fetchImpl: fetchSpy(), setOutput: outputs(), log: quiet });
  const c = gh.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
  assert.match(c.body.body, /запуск завершився з помилкою/);
});
