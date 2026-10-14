const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const { sendStatus } = require('../src/status');

const quiet = { warn() {}, log() {} };
const fakeFetch = (res = { ok: true, status: 200 }) => {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, ...opts }); return res; };
  f.calls = calls;
  return f;
};

test('sendStatus: тіло {ts, repo, status, until} і HMAC сирого тіла — як перевіряє Kando', async () => {
  const fetchImpl = fakeFetch();
  const ok = await sendStatus({
    url: 'https://kando/api/github/agent-status', secret: 's3cret', repo: 'eshkil/kando-board',
    status: 'limit', until: new Date('2025-10-14T17:00:00Z'), now: 1760450000000, fetchImpl, log: quiet,
  });
  assert.equal(ok, true);
  const [c] = fetchImpl.calls;
  assert.equal(c.url, 'https://kando/api/github/agent-status');
  assert.equal(c.method, 'POST');
  assert.deepEqual(JSON.parse(c.body), { ts: 1760450000000, repo: 'eshkil/kando-board', status: 'limit', until: '2025-10-14T17:00:00.000Z' });
  // Та сама перевірка, що в kando-board backend/routes/github.js (agentStatus).
  const expected = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(Buffer.from(c.body)).digest('hex');
  assert.equal(c.headers['X-Agent-Signature-256'], expected);
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.ok(c.signal instanceof AbortSignal);
});

test('sendStatus: ok — без until', async () => {
  const fetchImpl = fakeFetch();
  await sendStatus({ url: 'https://k/s', secret: 's', repo: 'o/r', status: 'ok', now: 1, fetchImpl, log: quiet });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), { ts: 1, repo: 'o/r', status: 'ok' });
});

test('sendStatus: без status_url або секрету запиту немає', async () => {
  const fetchImpl = fakeFetch();
  assert.equal(await sendStatus({ url: '', secret: 's', repo: 'o/r', status: 'ok', fetchImpl, log: quiet }), false);
  assert.equal(await sendStatus({ url: 'https://k/s', secret: '', repo: 'o/r', status: 'ok', fetchImpl, log: quiet }), false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('sendStatus: мережева помилка чи не-2xx не кидає, а повертає false', async () => {
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await sendStatus({ url: 'https://k/s', secret: 's', repo: 'o/r', status: 'ok', fetchImpl: boom, log: quiet }), false);
  const s503 = fakeFetch({ ok: false, status: 503 });
  assert.equal(await sendStatus({ url: 'https://k/s', secret: 's', repo: 'o/r', status: 'ok', fetchImpl: s503, log: quiet }), false);
});

test('sendStatus: сервер, що не відповідає, обривається за таймаутом', async () => {
  const server = http.createServer(() => {}); // ніколи не відповідає
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/s`;
  const t0 = Date.now();
  const ok = await sendStatus({ url, secret: 's', repo: 'o/r', status: 'ok', timeoutMs: 200, log: quiet });
  server.closeAllConnections();
  server.close();
  assert.equal(ok, false);
  assert.ok(Date.now() - t0 < 2000);
});
