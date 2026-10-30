const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { oidcToken, call, paths } = require('../src/runner/kando');
const { start } = require('../src/runner/start');
const { beat, run: heartbeatLoop } = require('../src/runner/heartbeat');
const { finish, isStuck, outcomeOf } = require('../src/runner/finish');
const { setupCommands, runSetup } = require('../src/runner/setup');

const BIN = path.join(__dirname, '..', 'bin');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kando-runner-'));
const silent = { log: () => {} };
const noSleep = async () => {};

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const baseEnv = (dir, extra = {}) => ({
  RUNNER_TEMP: dir,
  KANDO_URL: 'https://kando.test',
  KANDO_RUN_ID: '42',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.test/oidc?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req-token',
  GITHUB_REPOSITORY: 'acme/app',
  ...extra,
});

// Фейковий fetch: OIDC і Kando розрізняє за URL, запити записує.
function fakeFetch({ routes = {}, oidc = 'oidc-jwt' } = {}) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url: String(url), opts, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (String(url).startsWith('https://actions.test/')) return json(200, { value: oidc });
    for (const [suffix, handler] of Object.entries(routes)) {
      if (String(url).endsWith(suffix)) return typeof handler === 'function' ? handler(calls) : handler;
    }
    throw new Error(`несподіваний запит ${url}`);
  };
  f.calls = calls;
  return f;
}

// ─── kando.js ────────────────────────────────────────────────────────────────
test('oidcToken: додає audience=kando-agent до URL і Bearer із ACTIONS_ID_TOKEN_REQUEST_TOKEN', async () => {
  const f = fakeFetch();
  const token = await oidcToken(baseEnv('/x'), f);
  assert.equal(token, 'oidc-jwt');
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get('audience'), 'kando-agent');
  assert.equal(u.searchParams.get('api-version'), '2.0');
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer req-token');
});

test('oidcToken: без змінних Actions → зрозуміла помилка про id-token: write', async () => {
  await assert.rejects(oidcToken({}, fakeFetch()), /id-token: write/);
});

test('call: повторює 502 тричі з паузою і кидає останню помилку', async () => {
  let n = 0;
  const sleeps = [];
  const f = async () => { n++; return json(502, { error: 'GitHub не відповів' }); };
  await assert.rejects(call('https://k.test/', '/api/x', {}, { oidc: 't', fetchImpl: f, sleep: async ms => sleeps.push(ms) }),
    e => e.status === 502 && /GitHub не відповів/.test(e.message));
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [5000, 5000]);
});

test('call: 403 не повторює; Bearer, JSON-тіло і склейка URL без подвійного слеша', async () => {
  let n = 0, seen;
  const f = async (url, opts) => { n++; seen = { url, opts }; return json(403, { error: 'чужий' }); };
  await assert.rejects(call('https://k.test/', '/api/x', { a: 1 }, { oidc: 'jwt', fetchImpl: f, sleep: noSleep }), e => e.status === 403);
  assert.equal(n, 1);
  assert.equal(seen.url, 'https://k.test/api/x');
  assert.equal(seen.opts.headers.Authorization, 'Bearer jwt');
  assert.equal(seen.opts.body, '{"a":1}');
});

test('call: мережева помилка повторюється, успіх на другій спробі повертає json', async () => {
  let n = 0;
  const f = async () => { if (++n === 1) throw new Error('ECONNRESET'); return json(200, { ok: 1 }); };
  assert.deepEqual(await call('https://k.test', '/p', {}, { oidc: 't', fetchImpl: f, sleep: noSleep }), { ok: 1 });
  assert.equal(n, 2);
});

// ─── start ───────────────────────────────────────────────────────────────────
const startResponse = { github_token: 'ghs_first', expires_at: '2030-01-01T00:00:00Z', prompt: 'Рядок 1\nРядок 2', model: 'claude-opus-5-5', skill: 'implement', mode: 'first', bot: { login: 'kando[bot]', id: 77 }, issue: 5, pr: null };

test('start: токен у файлі з правами 0600, вихід prompt, маска токена, без токена у виходах', async () => {
  const dir = tmp();
  const env = baseEnv(dir);
  const f = fakeFetch({ routes: { '/api/agent/runs/42/start': json(200, startResponse) } });
  const out = {}, lines = [];
  await start({ env, fetchImpl: f, setOutput: (k, v) => { out[k] = v; }, log: { log: l => lines.push(l) } });

  const file = paths(env).token;
  assert.equal(fs.readFileSync(file, 'utf8'), 'ghs_first');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(out.prompt, 'Рядок 1\nРядок 2');
  assert.equal(out.model, 'claude-opus-5-5');
  assert.equal(out.bot_login, 'kando[bot]');
  assert.equal(out.bot_id, 77);
  assert.equal(out.issue, 5);
  assert.equal(out.pr, '');
  assert.ok(!Object.values(out).some(v => String(v).includes('ghs_first')));
  assert.ok(lines.includes('::add-mask::ghs_first'));
  assert.ok(!lines.filter(l => !l.startsWith('::add-mask::')).some(l => l.includes('ghs_first')));
  assert.equal(f.calls.find(c => c.url.endsWith('/start')).opts.headers.Authorization, 'Bearer oidc-jwt');
});

test('start: 409 (запуск не очікує старту) → помилка, файл токена не створено', async () => {
  const dir = tmp();
  const f = fakeFetch({ routes: { '/start': json(409, { error: 'Запуск у стані running' }) } });
  await assert.rejects(start({ env: baseEnv(dir), fetchImpl: f, sleep: noSleep, log: silent }), e => e.status === 409);
  assert.ok(!fs.existsSync(paths(baseEnv(dir)).token));
});

test('start: прибирає stop-файл попереднього запуску на тому ж раннері', async () => {
  const dir = tmp();
  const env = baseEnv(dir);
  fs.mkdirSync(paths(env).dir, { recursive: true });
  fs.writeFileSync(paths(env).stop, '');
  await start({ env, fetchImpl: fakeFetch({ routes: { '/start': json(200, startResponse) } }), log: silent });
  assert.ok(!fs.existsSync(paths(env).stop));
});

// ─── heartbeat ───────────────────────────────────────────────────────────────
test('heartbeat: перезаписує файл токена новим, права лишаються 0600, токен не друкується', async () => {
  const dir = tmp();
  const env = baseEnv(dir);
  const file = paths(env).token;
  fs.mkdirSync(paths(env).dir, { recursive: true });
  fs.writeFileSync(file, 'ghs_old', { mode: 0o600 });
  const lines = [];
  const f = fakeFetch({ routes: { '/api/agent/runs/42/heartbeat': json(200, { github_token: 'ghs_new', expires_at: 'x' }) } });
  assert.equal(await beat({ env, fetchImpl: f, log: { log: l => lines.push(l) } }), 'ok');
  assert.equal(fs.readFileSync(file, 'utf8'), 'ghs_new');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(paths(env).dir), ['token']);   // тимчасових файлів не лишилось
  assert.ok(!lines.join('\n').includes('ghs_'));
});

test('heartbeat: мережевий збій не кидає, старий токен лишається, наступний тік відновлює', async () => {
  const dir = tmp();
  const env = baseEnv(dir);
  fs.mkdirSync(paths(env).dir, { recursive: true });
  fs.writeFileSync(paths(env).token, 'ghs_old');
  let n = 0;
  const f = async url => {
    if (String(url).startsWith('https://actions.test/')) return json(200, { value: 'j' });
    if (++n <= 3) throw new Error('ETIMEDOUT');         // три спроби call першого тіку
    return json(200, { github_token: 'ghs_new' });
  };
  assert.equal(await beat({ env, fetchImpl: f, sleep: noSleep, log: silent }), 'retry');
  assert.equal(fs.readFileSync(paths(env).token, 'utf8'), 'ghs_old');
  assert.equal(await beat({ env, fetchImpl: f, sleep: noSleep, log: silent }), 'ok');
  assert.equal(fs.readFileSync(paths(env).token, 'utf8'), 'ghs_new');
});

test('heartbeat: збій OIDC теж лише логується (retry)', async () => {
  const env = baseEnv(tmp(), { ACTIONS_ID_TOKEN_REQUEST_URL: '' });
  assert.equal(await beat({ env, fetchImpl: fakeFetch(), log: silent }), 'retry');
});

test('heartbeat: 409 від Kando → stop', async () => {
  const f = fakeFetch({ routes: { '/heartbeat': json(409, { error: 'Запуск уже завершено' }) } });
  assert.equal(await beat({ env: baseEnv(tmp()), fetchImpl: f, sleep: noSleep, log: silent }), 'stop');
});

test('heartbeat: цикл зупиняється за stop-файлом, на 409 і за стелею часу', async () => {
  const dir = tmp();
  const env = baseEnv(dir);
  fs.mkdirSync(paths(env).dir, { recursive: true });
  let beats = 0;
  const f = fakeFetch({ routes: { '/heartbeat': () => { beats++; return json(200, { github_token: `ghs_${beats}` }); } } });

  // stop-файл з'являється під час другої паузи
  let ticks = 0;
  const sleep = async () => { if (++ticks === 3) fs.writeFileSync(paths(env).stop, ''); };
  assert.equal(await heartbeatLoop({ env, fetchImpl: f, sleep, log: silent }), 'stopped');
  assert.equal(beats, 2);
  fs.rmSync(paths(env).stop);

  const g = fakeFetch({ routes: { '/heartbeat': json(409, { error: 'done' }) } });
  assert.equal(await heartbeatLoop({ env, fetchImpl: g, sleep: noSleep, retryMs: 0, log: silent }), 'final');

  let t = 0;
  assert.equal(await heartbeatLoop({ env, fetchImpl: f, sleep: noSleep, now: () => (t += 1000), maxMs: 3500, log: silent }), 'expired');
});

// ─── finish ──────────────────────────────────────────────────────────────────
const executionFile = (dir, messages) => {
  const file = path.join(dir, 'execution.json');
  fs.writeFileSync(file, JSON.stringify(messages));
  return file;
};
const rejectedEvent = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1760461200 } };

test('finish: failure і rate_limit_event rejected → limit.limited з ISO-часом; /finish з Bearer OIDC', async () => {
  const dir = tmp();
  const env = baseEnv(dir, { CLAUDE_OUTCOME: 'failure', EXECUTION_FILE: executionFile(dir, [rejectedEvent]) });
  const f = fakeFetch({ routes: { '/api/agent/runs/42/finish': json(200, { status: 'limit' }) } });
  const { body } = await finish({ env, fetchImpl: f, log: silent });
  assert.deepEqual(body, { outcome: 'failure', limit: { limited: true, until: '2025-10-14T17:00:00.000Z' }, stuck: false });
  const sent = f.calls.find(c => c.url.endsWith('/finish'));
  assert.deepEqual(sent.body, body);
  assert.equal(sent.opts.headers.Authorization, 'Bearer oidc-jwt');
});

test('finish: success ігнорує журнал ліміту; skipped → failure; невідоме → failure', async () => {
  const dir = tmp();
  const f = fakeFetch({ routes: { '/finish': json(200, { status: 'succeeded' }) } });
  const ok = await finish({ env: baseEnv(dir, { CLAUDE_OUTCOME: 'success', EXECUTION_FILE: executionFile(dir, [rejectedEvent]) }), fetchImpl: f, log: silent });
  assert.deepEqual(ok.body, { outcome: 'success', limit: { limited: false, until: null }, stuck: false });
  assert.equal(outcomeOf('skipped'), 'failure');
  assert.equal(outcomeOf(''), 'failure');
  assert.equal(outcomeOf('cancelled'), 'cancelled');
});

test('finish: кладе stop-файл для heartbeat раніше, ніж іде в мережу', async () => {
  const dir = tmp();
  const env = baseEnv(dir, { CLAUDE_OUTCOME: 'success' });
  let stopAtCall;
  const f = fakeFetch({ routes: { '/finish': () => { stopAtCall = fs.existsSync(paths(env).stop); return json(200, { status: 'succeeded' }); } } });
  await finish({ env, fetchImpl: f, log: silent });
  assert.equal(stopAtCall, true);
});

test('finish: stuck=true, якщо на задачі лишився ai:in-progress (перевіряє issue і pr)', async () => {
  const dir = tmp();
  const env = baseEnv(dir, { CLAUDE_OUTCOME: 'success', ISSUE: '5', PR: '9' });
  fs.mkdirSync(paths(env).dir, { recursive: true });
  fs.writeFileSync(paths(env).token, 'ghs_cur');
  const seen = [];
  const f = async (url, opts) => {
    if (String(url).startsWith('https://actions.test/')) return json(200, { value: 'j' });
    if (String(url).startsWith('https://api.github.com/')) {
      seen.push({ url: String(url), auth: opts.headers.Authorization });
      return json(200, { labels: String(url).endsWith('/9') ? [{ name: 'ai:in-progress' }] : [{ name: 'ai:triaged' }] });
    }
    return json(200, { status: 'failed' });
  };
  const { body } = await finish({ env, fetchImpl: f, log: silent });
  assert.equal(body.stuck, true);
  assert.deepEqual(seen.map(s => s.url), ['https://api.github.com/repos/acme/app/issues/5', 'https://api.github.com/repos/acme/app/issues/9']);
  assert.ok(seen.every(s => s.auth === 'Bearer ghs_cur'));
});

test('isStuck: без лейбла, без номерів і при збої GitHub → false', async () => {
  const dir = tmp();
  const env = baseEnv(dir);
  fs.mkdirSync(paths(env).dir, { recursive: true });
  fs.writeFileSync(paths(env).token, 'ghs');
  const clean = async () => json(200, { labels: [{ name: 'ai:reviewed' }] });
  assert.equal(await isStuck({ env, numbers: [5], fetchImpl: clean, log: silent }), false);
  assert.equal(await isStuck({ env, numbers: [], fetchImpl: clean, log: silent }), false);
  assert.equal(await isStuck({ env, numbers: [5], fetchImpl: async () => json(500, {}), log: silent }), false);
  assert.equal(await isStuck({ env, numbers: [5], fetchImpl: async () => { throw new Error('net'); }, log: silent }), false);
});

test('finish: 409 від Kando піднімається як KandoError зі статусом 409', async () => {
  const f = fakeFetch({ routes: { '/finish': json(409, { error: 'Запуск уже завершено' }) } });
  await assert.rejects(finish({ env: baseEnv(tmp(), { CLAUDE_OUTCOME: 'success' }), fetchImpl: f, log: silent }), e => e.status === 409);
});

// ─── setup ───────────────────────────────────────────────────────────────────
test('setupCommands: масив, один рядок, порожнє й некоректний JSON', () => {
  assert.deepEqual(setupCommands('{"node":"22","setup":["npm ci"," ","npm run build"]}'), ['npm ci', 'npm run build']);
  assert.deepEqual(setupCommands('{"setup":"make deps"}'), ['make deps']);
  assert.deepEqual(setupCommands('{}'), []);
  assert.deepEqual(setupCommands(''), []);
  assert.throws(() => setupCommands('{oops'), /JSON/);
});

test('runSetup: кожен рядок окремо через bash -e; перша невдача зупиняє', () => {
  const seen = [];
  const spawn = (cmd, args) => { seen.push([cmd, ...args]); return { status: args[2] === 'bad' ? 3 : 0 }; };
  assert.throws(() => runSetup({ envJson: '{"setup":["ok","bad","never"]}', spawn, log: silent }), /«bad».*3/);
  assert.deepEqual(seen, [['bash', '-e', '-c', 'ok'], ['bash', '-e', '-c', 'bad']]);
});

// ─── bin/gh ──────────────────────────────────────────────────────────────────
function fakeGh(dir, label) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'gh');
  fs.writeFileSync(file, `#!/bin/sh\necho "${label} token=$GH_TOKEN args=$*"\n`, { mode: 0o755 });
  return file;
}
// Системні каталоги в кінці PATH — для cat/dirname; gh там немає, тож не заважає.
const runGh = (pathDirs, env = {}, args = ['pr', 'list']) =>
  spawnSync(path.join(BIN, 'gh'), args, { encoding: 'utf8', env: { PATH: [...pathDirs, '/usr/bin', '/bin'].join(':'), ...env } });

test('bin/gh: шукає справжній gh у PATH, пропускаючи власний каталог (без жорсткого шляху)', () => {
  const root = tmp();
  fakeGh(path.join(root, 'real'), 'REAL');
  const token = path.join(root, 'token');
  fs.writeFileSync(token, 'ghs_file');
  // BIN першим у PATH: без пропуску обгортка викликала б сама себе.
  const r = runGh([BIN, path.join(root, 'real')], { KANDO_TOKEN_FILE: token });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'REAL token=ghs_file args=pr list');
});

test('bin/gh: свій каталог пропускається і через симлінк / порожній елемент PATH; береться перший справжній', () => {
  const root = tmp();
  fakeGh(path.join(root, 'first'), 'FIRST');
  fakeGh(path.join(root, 'second'), 'SECOND');
  fs.symlinkSync(BIN, path.join(root, 'link-to-bin'));
  const token = path.join(root, 'token');
  fs.writeFileSync(token, 't');
  const r = runGh([path.join(root, 'link-to-bin'), '', path.join(root, 'first'), path.join(root, 'second')], { KANDO_TOKEN_FILE: token });
  assert.equal(r.stdout.trim(), 'FIRST token=t args=pr list');
});

test('bin/gh: токен береться з RUNNER_TEMP/kando/token і перекриває GH_TOKEN зі середовища', () => {
  const root = tmp();
  fakeGh(path.join(root, 'real'), 'REAL');
  fs.mkdirSync(path.join(root, 'tmp', 'kando'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp', 'kando', 'token'), 'ghs_fresh\n');
  const r = runGh([BIN, path.join(root, 'real')], { RUNNER_TEMP: path.join(root, 'tmp'), GH_TOKEN: 'stale' });
  assert.equal(r.stdout.trim(), 'REAL token=ghs_fresh args=pr list');
});

test('bin/gh: немає gh у PATH → код 127 з поясненням', () => {
  const r = runGh([BIN, '/nonexistent']);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /gh/);
});

// ─── bin/git-credential-kando ────────────────────────────────────────────────
const cred = (op, input, env) =>
  spawnSync(path.join(BIN, 'git-credential-kando'), [op], { input, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } });

test('git-credential-kando: get для github.com видає username і токен з файлу', () => {
  const root = tmp();
  const token = path.join(root, 'token');
  fs.writeFileSync(token, 'ghs_cred');
  const r = cred('get', 'protocol=https\nhost=github.com\npath=acme/app.git\n\n', { KANDO_TOKEN_FILE: token });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'username=x-access-token\npassword=ghs_cred\n');
});

test('git-credential-kando: чужий хост, store/erase і відсутній токен — мовчить', () => {
  const root = tmp();
  const token = path.join(root, 'token');
  fs.writeFileSync(token, 'ghs_cred');
  const env = { KANDO_TOKEN_FILE: token };
  for (const host of ['gitlab.com', 'github.com.evil.test', 'evilgithub.com', 'api.github.com']) {
    const r = cred('get', `protocol=https\nhost=${host}\n\n`, env);
    assert.equal(r.stdout, '', host);
    assert.equal(r.status, 0);
  }
  assert.equal(cred('store', 'protocol=https\nhost=github.com\npassword=x\n\n', env).stdout, '');
  assert.equal(cred('erase', 'protocol=https\nhost=github.com\n\n', env).stdout, '');
  assert.equal(cred('get', 'protocol=https\nhost=github.com\n\n', { KANDO_TOKEN_FILE: path.join(root, 'none') }).stdout, '');
});
