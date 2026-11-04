const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'plugin', 'bin', 'kando-session');
const SID = 'abc-123';

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// ─── стенд ───────────────────────────────────────────────────────────────────
// Фейковий Kando: записує запити, відповідає за чергою/функцією; mode 'hang' — мовчить.
async function fakeKando(handler) {
  const reqs = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const r = { method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      reqs.push(r);
      const out = handler === 'hang' ? null : (typeof handler === 'function' ? handler(r, reqs) : handler);
      if (!out) return; // не відповідаємо
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    reqs,
    close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(r); }),
  };
}

function sandbox({ token = 'tok-secret', origin = 'git@github.com:o/r.git', underGit = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-home-'));
  let cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ks repo '));
  tmpDirs.push(home, cwd);
  if (underGit) { cwd = path.join(cwd, 'git', 'work'); fs.mkdirSync(cwd, { recursive: true }); }
  if (token !== null) {
    fs.mkdirSync(path.join(home, '.config', 'kando'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'kando', 'token'), token + '\n');
  }
  spawnSync('git', ['init', '-q', cwd]);
  if (origin) spawnSync('git', ['-C', cwd, 'remote', 'add', 'origin', origin]);
  const sdir = path.join(home, '.config', 'kando', 'sessions');
  return {
    home, cwd, sdir,
    state: (id = SID) => path.join(sdir, id),
    writeState(id = SID, repo = 'o/r') {
      fs.mkdirSync(sdir, { recursive: true });
      fs.writeFileSync(path.join(sdir, id), `repo=${repo}\nnumber=7\nskill=implement\n`);
    },
    setBeat(sec, id = SID) { fs.writeFileSync(path.join(sdir, id + '.beat'), String(sec)); },
  };
}

function run(sb, url, args, { stdin = '', env = {}, cwd = sb.cwd, path: PATH } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(SCRIPT, args, {
      cwd,
      env: { PATH: PATH || process.env.PATH, HOME: sb.home, KANDO_URL: url, ...env },
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.stdin.on('error', () => {});
    p.stdin.end(stdin);
    p.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e), ms: Date.now() - t0 }));
    p.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
  });
}

const hookIn = (sb, extra = {}) =>
  JSON.stringify({ session_id: SID, cwd: sb.cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', ...extra });
const bashIn = (sb, command) => hookIn(sb, { hook_event_name: 'PreToolUse', tool_input: { command } });
const HELD = { status: 200, body: { managed: true, held: true } };
const LOST = (message = 'Задачу вже тримає @bob', lost = 'takeover') =>
  ({ status: 409, body: { managed: true, held: false, lost, own: false, holder: 'bob', message } });
// Claude має зупинитись і чекати людину, а не перезапускати скіл сам.
function assertStopText(t) {
  assert.match(t, /втрачено/);
  assert.match(t, /Зупинись/);
  assert.match(t, /нічого не пуш/);
  assert.match(t, /скажи про це людині/);
  assert.match(t, /чекай її рішення/);
  // Вихід із блокування є, але рішення за людиною.
  assert.match(t, /Лише якщо людина вирішить кинути задачу/);
  assert.match(t, /Сам цього не роби/);
  assert.doesNotMatch(t, /знову|заново|begin|перезапуск/i);
}
const begin = (sb, url, more = [], opts) =>
  run(sb, url, ['begin', '--session', SID, '--number', '7', '--skill', 'implement', ...more], opts);

async function withKando(handler, fn) {
  const k = await fakeKando(handler);
  try { await fn(k); } finally { await k.close(); }
}

// ─── begin ───────────────────────────────────────────────────────────────────
test('begin: 200 held → код 0, стан записано, у запиті begin, Bearer і repo', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    const r = await begin(sb, k.url);
    assert.equal(r.code, 0);
    assert.equal(k.reqs.length, 1);
    assert.equal(k.reqs[0].method, 'PUT');
    assert.equal(k.reqs[0].url, `/api/agent/local-sessions/${SID}`);
    assert.equal(k.reqs[0].auth, 'Bearer tok-secret');
    assert.deepEqual(k.reqs[0].body, { repo: 'o/r', number: 7, skill: 'implement', begin: true });
    const st = fs.readFileSync(sb.state(), 'utf8');
    assert.match(st, /^repo=o\/r$/m);
    assert.match(st, /^number=7$/m);
    assert.match(st, /^skill=implement$/m);
    assert.ok(fs.existsSync(sb.state() + '.beat'));
  });
});

for (const origin of [
  'git@github.com:o/r.git',
  'https://github.com/o/r.git',
  'https://github.com/o/r',
  'ssh://git@github.com/o/r',
]) {
  test(`begin: repo з origin ${origin}`, async () => {
    await withKando(HELD, async (k) => {
      const sb = sandbox({ origin });
      await begin(sb, k.url);
      assert.equal(k.reqs[0].body.repo, 'o/r');
    });
  });
}

test('begin: 409 → код 3, надруковано message, стану немає, --takeover іде в тілі', async () => {
  await withKando(LOST('Задачу тримає @bob у сесії X'), async (k) => {
    const sb = sandbox();
    const r = await begin(sb, k.url, ['--takeover']);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /Задачу тримає @bob у сесії X/);
    assert.equal(k.reqs[0].body.takeover, true);
    assert.ok(!fs.existsSync(sb.state()));
  });
});

// ─── --repo: скіл міг узяти задачу з іншого репо, ніж origin ─────────────────
test('begin: --repo не збігається з origin → код 0, причина, без запитів і стану', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    const r = await begin(sb, k.url, ['--repo', 'other/thing']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /other\/thing/);
    assert.match(r.stdout, /o\/r/);
    assert.equal(k.reqs.length, 0);
    assert.ok(!fs.existsSync(sb.state()));
  });
});

test('begin: --repo збігається з origin без урахування регістру → задачу взято', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox({ origin: 'git@github.com:Org/Repo.git' });
    const r = await begin(sb, k.url, ['--repo', 'org/REPO']);
    assert.equal(r.code, 0);
    assert.equal(k.reqs.length, 1);
    assert.equal(k.reqs[0].body.repo, 'Org/Repo');
    assert.ok(fs.existsSync(sb.state()));
  });
});

test('begin: --repo із порожнім значенням (змінна не збереглась) → за origin', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    await begin(sb, k.url, ['--repo', '']);
    assert.equal(k.reqs[0].body.repo, 'o/r');
  });
});

test('begin: --repo зі спецсимволами не ламає вивід', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    const r = await begin(sb, k.url, ['--repo', 'a"b\nc/d']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.equal(k.reqs.length, 0);
  });
});

test('begin: без --takeover поля takeover у тілі немає', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    await begin(sb, k.url);
    assert.ok(!('takeover' in k.reqs[0].body));
  });
});

test('begin: { managed: false } → код 0, стану немає', async () => {
  await withKando({ status: 200, body: { managed: false } }, async (k) => {
    const sb = sandbox();
    const r = await begin(sb, k.url);
    assert.equal(r.code, 0);
    assert.ok(!fs.existsSync(sb.state()));
  });
});

for (const status of [401, 403]) {
  test(`begin: ${status} → код 0, попередження, стану немає`, async () => {
    await withKando({ status, body: { error: 'x' } }, async (k) => {
      const sb = sandbox();
      const r = await begin(sb, k.url);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Kando/);
      assert.ok(!fs.existsSync(sb.state()));
    });
  });
}

test('begin: --session з переносом рядка ($\'abc\\n../../pwn\') відхиляється', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    const r = await run(sb, k.url, ['begin', '--session', 'abc\n../../pwn', '--number', '7', '--skill', 'implement']);
    assert.equal(r.code, 0);
    assert.equal(k.reqs.length, 0);
    assert.ok(!fs.existsSync(sb.sdir) || fs.readdirSync(sb.sdir).length === 0);
    for (const bad of [['--number', '7\nx', '--skill', 'implement'], ['--number', '7', '--skill', 'a\nb']]) {
      const r2 = await run(sb, k.url, ['begin', '--session', SID, ...bad]);
      assert.equal(r2.code, 0);
    }
    assert.equal(k.reqs.length, 0);
  });
});

test('begin: порожній файл токена = немає токена', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox({ token: '' });
    fs.writeFileSync(path.join(sb.home, '.config', 'kando', 'token'), '  \n');
    const r = await begin(sb, k.url);
    assert.equal(r.code, 0);
    assert.equal(k.reqs.length, 0);
    assert.ok(!fs.existsSync(sb.state()));
  });
});

test('begin: без токена → код 0, запитів немає', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox({ token: null });
    const r = await begin(sb, k.url);
    assert.equal(r.code, 0);
    assert.equal(k.reqs.length, 0);
    assert.ok(!fs.existsSync(sb.state()));
  });
});

test('GITHUB_ACTIONS=true: begin, end і хуки нічого не роблять', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    sb.writeState();
    const env = { GITHUB_ACTIONS: 'true' };
    assert.equal((await begin(sb, k.url, [], { env })).code, 0);
    await run(sb, k.url, ['end', '--session', SID], { env });
    await run(sb, k.url, ['hook', 'post-tool'], { env, stdin: hookIn(sb) });
    const pre = await run(sb, k.url, ['hook', 'pre-tool'], { env, stdin: bashIn(sb, 'git push') });
    await run(sb, k.url, ['hook', 'session-end'], { env, stdin: hookIn(sb, { reason: 'clear' }) });
    assert.equal(pre.stdout, '');
    assert.equal(k.reqs.length, 0);
    assert.ok(fs.existsSync(sb.state()));
    assert.ok(!fs.existsSync(sb.state() + '.beat'));
  });
  const sb2 = sandbox();
  await withKando(HELD, async (k) => {
    await begin(sb2, k.url, [], { env: { GITHUB_ACTIONS: 'true' } });
    assert.ok(!fs.existsSync(sb2.sdir));
  });
});

test('begin: прибирає файли стану старші за 7 днів', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    sb.writeState('old-1');
    sb.writeState('fresh-1');
    const old = new Date(Date.now() - 8 * 86400e3);
    fs.utimesSync(sb.state('old-1'), old, old);
    await begin(sb, k.url);
    assert.ok(!fs.existsSync(sb.state('old-1')));
    assert.ok(fs.existsSync(sb.state('fresh-1')));
  });
});

test('begin: cwd без origin → код 0, запитів і стану немає', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox({ origin: null });
    const r = await begin(sb, k.url);
    assert.equal(r.code, 0);
    assert.equal(k.reqs.length, 0);
    assert.ok(!fs.existsSync(sb.state()));
  });
});

test('begin: origin не на GitHub → код 0, запитів і стану немає', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox({ origin: 'https://gitlab.com/o/r' });
    const r = await begin(sb, k.url);
    assert.equal(r.code, 0);
    assert.equal(k.reqs.length, 0);
    assert.ok(!fs.existsSync(sb.state()));
  });
});

test('begin: шлях із пробілами працює', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    assert.match(sb.cwd, / /);
    const r = await begin(sb, k.url);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(sb.state()));
  });
});

test('begin: --session "../x" → код 0, нічого поза sessions/', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    const r = await run(sb, k.url, ['begin', '--session', '../x', '--number', '7', '--skill', 'implement']);
    assert.equal(r.code, 0);
    assert.equal(k.reqs.length, 0);
    assert.ok(!fs.existsSync(path.join(sb.home, '.config', 'kando', 'x')));
    assert.ok(!fs.existsSync(path.join(sb.sdir, '..', 'x')));
  });
});

test('begin: сервер недоступний (порт закрито) → код 0, стан записано', async () => {
  const k = await fakeKando(HELD);
  const url = k.url;
  await k.close();
  const sb = sandbox();
  const r = await begin(sb, url);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(sb.state()));
});

// ─── hook post-tool ──────────────────────────────────────────────────────────
test('post-tool: без стану → без запитів і виводу', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    const r = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(k.reqs.length, 0);
  });
});

test('post-tool: перший виклик → PUT без begin; другий за 60 с без запиту; після зсуву .beat — запит', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    sb.writeState();
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(k.reqs.length, 1);
    assert.equal(k.reqs[0].method, 'PUT');
    assert.deepEqual(k.reqs[0].body, { repo: 'o/r', number: 7, skill: 'implement' });
    assert.equal(k.reqs[0].auth, 'Bearer tok-secret');
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(k.reqs.length, 1);
    sb.setBeat(Math.floor(Date.now() / 1000) - 61);
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(k.reqs.length, 2);
  });
});

test('post-tool: інший репо в cwd → без запиту', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox({ origin: 'git@github.com:other/thing.git' });
    sb.writeState();
    const r = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(r.stdout, '');
    assert.equal(k.reqs.length, 0);
  });
});

test('post-tool: 409 → additionalContext з message; другий 409 мовчить; 200 прибирає .warned; стан лишається', async () => {
  let answer = LOST('Перехоплено @bob: "лапки" і \\ слеш\nновий рядок');
  await withKando(() => answer, async (k) => {
    const sb = sandbox();
    sb.writeState();
    const r1 = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    const out = JSON.parse(r1.stdout); // має бути валідний JSON попри спецсимволи
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /Перехоплено @bob/);
    assertStopText(out.hookSpecificOutput.additionalContext);
    assert.ok(fs.existsSync(sb.state() + '.warned'));
    assert.ok(fs.existsSync(sb.state()));

    sb.setBeat(0);
    const r2 = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(r2.stdout, '');
    assert.equal(k.reqs.length, 2);

    answer = HELD;
    sb.setBeat(0);
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.ok(!fs.existsSync(sb.state() + '.warned'));
    assert.ok(fs.existsSync(sb.state()));
  });
});

test('post-tool: { managed: false } → стан видалено', async () => {
  await withKando({ status: 200, body: { managed: false } }, async (k) => {
    const sb = sandbox();
    sb.writeState();
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.ok(!fs.existsSync(sb.state()));
  });
});

// Захист зникає разом зі станом, тож Claude має про це сказати людині. Наступні хуки стану вже
// не бачать, тож попередження одне.
for (const status of [401, 403]) {
  test(`post-tool: ${status} → стан видалено, один раз сказано через additionalContext`, async () => {
    await withKando({ status, body: { error: 'x' } }, async (k) => {
      const sb = sandbox();
      sb.writeState();
      const r = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
      const out = JSON.parse(r.stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
      const t = out.hookSpecificOutput.additionalContext;
      assert.match(t, new RegExp(`${status}`));
      assert.match(t, /перевірки перед пушем немає/);
      assert.match(t, /Скажи про це людині/);
      assert.doesNotMatch(t, /втрачено|Зупинись/, 'це не втрата задачі: роботу не зупиняємо');
      assert.ok(!fs.existsSync(sb.state()));
      const again = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
      assert.equal(again.stdout, '');
      assert.equal(k.reqs.length, 1);
    });
  });

  test(`pre-tool: ${status} → команда йде, стан видалено, один раз сказано`, async () => {
    await withKando({ status, body: { error: 'x' } }, async (k) => {
      const sb = sandbox();
      sb.writeState();
      const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
      const out = JSON.parse(r.stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
      assert.match(out.hookSpecificOutput.additionalContext, /перевірки перед пушем немає/);
      assert.ok(!fs.existsSync(sb.state()));
      const again = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
      assert.equal(again.stdout, '');
      assert.equal(k.reqs.length, 1);
    });
  });
}

// Сигнал розминувся з кінцем скіла (паралельний хук прочитав стан до end). Сесія нічого не
// втратила: скіл закінчив роботу сам, тож ані попередження, ані заборони, лише прибрати стан.
const SKILL_DONE = { status: 409, body: { managed: true, held: false, lost: 'skill_done' } };

test('post-tool: lost skill_done → без попередження, стан видалено, далі запитів немає', async () => {
  await withKando(SKILL_DONE, async (k) => {
    const sb = sandbox();
    sb.writeState();
    const r = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(r.stdout, '');
    assert.ok(!fs.existsSync(sb.state()));
    assert.ok(!fs.existsSync(sb.state() + '.beat'));
    assert.ok(!fs.existsSync(sb.state() + '.warned'));
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(k.reqs.length, 1);
  });
});

test('pre-tool: lost skill_done → без заборони, стан видалено', async () => {
  await withKando(SKILL_DONE, async (k) => {
    const sb = sandbox();
    sb.writeState();
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
    assert.equal(r.stdout, '');
    assert.ok(!fs.existsSync(sb.state()));
  });
});

test('post-tool: 409 з іншою втратою стан лишає (рядок skill_done у повідомленні нічого не значить)', async () => {
  await withKando(LOST('Текст зі словом skill_done і "lost" у ньому'), async (k) => {
    const sb = sandbox();
    sb.writeState();
    const r = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /втрачено/);
    assert.ok(fs.existsSync(sb.state()));
  });
});

// ─── begin, на який сервер не відповів ───────────────────────────────────────
// Та сама сесія щойно закінчила скіл на цій задачі, рядок на сервері skill_done. Сигнал без
// begin задачу не повертає, тож після збою begin перший сигнал мусить бути begin-ом. Інакше стан
// мовчки зникне, скіл працюватиме без утримання, а ▶ Агенту запустить другого агента.
const COLD = { status: 503, body: {} };
// Сервер, як справжній: перші n запитів — збій, далі сигнал без begin отримує skill_done.
const coldThenDone = (n = 1) => (r, reqs) => {
  if (reqs.length <= n) return COLD;
  return r.body.begin ? HELD : SKILL_DONE;
};

test('begin без відповіді після skill_done: перший сигнал бере задачу, стан лишається, далі звичайні сигнали', async () => {
  await withKando(coldThenDone(), async (k) => {
    const sb = sandbox();
    const b = await begin(sb, k.url);
    assert.equal(b.code, 0);
    assert.ok(fs.existsSync(sb.state()));

    const r = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(r.stdout, '');
    assert.deepEqual(k.reqs[1].body, { repo: 'o/r', number: 7, skill: 'implement', begin: true });
    assert.ok(fs.existsSync(sb.state()), 'стан не зник');
    assert.ok(!fs.existsSync(sb.state() + '.pending'), 'begin підтверджено');

    sb.setBeat(Math.floor(Date.now() / 1000) - 61);
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.deepEqual(k.reqs[2].body, { repo: 'o/r', number: 7, skill: 'implement' });
  });
});

test('begin без відповіді: сервер не відповідає й на сигнал → наступний сигнал теж begin', async () => {
  await withKando(coldThenDone(2), async (k) => {
    const sb = sandbox();
    await begin(sb, k.url);
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(k.reqs[1].body.begin, true);
    assert.ok(fs.existsSync(sb.state() + '.pending'), '5xx нічого не підтвердив');

    sb.setBeat(Math.floor(Date.now() / 1000) - 61);
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(k.reqs[2].body.begin, true);
    assert.ok(fs.existsSync(sb.state()));
    assert.ok(!fs.existsSync(sb.state() + '.pending'));
  });
});

test('begin без відповіді: перевірка перед пушем теж бере задачу', async () => {
  await withKando(coldThenDone(), async (k) => {
    const sb = sandbox();
    await begin(sb, k.url);
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
    assert.equal(r.stdout, '');
    assert.equal(k.reqs[1].body.begin, true);
    assert.ok(fs.existsSync(sb.state()));
    assert.ok(!fs.existsSync(sb.state() + '.pending'));
  });
});

test('begin без відповіді, далі 409: сервер відмовив, begin більше не повторюється, пуш заборонено без запиту', async () => {
  const handler = (r, reqs) => (reqs.length === 1 ? COLD : LOST('Задачу вже тримає @bob', null));
  await withKando(handler, async (k) => {
    const sb = sandbox();
    await begin(sb, k.url);
    const first = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
    assert.equal(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(k.reqs[1].body.begin, true);
    assert.ok(!fs.existsSync(sb.state() + '.pending'), 'сервер відповів');
    assert.ok(fs.existsSync(sb.state()), 'стан лишається: перевірка далі блокує');

    // Тримач міг уже закінчити, але зупинена сесія задачу собі не забирає.
    const again = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
    const out = JSON.parse(again.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /Задачу вже тримає @bob/);
    assertStopText(out.permissionDecisionReason);
    sb.setBeat(0);
    const post = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(post.stdout, '');
    assert.equal(k.reqs.length, 2, 'після відмови запитів більше немає');
  });
});

test('begin без відповіді, далі 409 у post-tool: попередження один раз, далі тиша', async () => {
  const handler = (r, reqs) => (reqs.length === 1 ? COLD : LOST('Задачу вже тримає @bob', null));
  await withKando(handler, async (k) => {
    const sb = sandbox();
    await begin(sb, k.url);
    const r = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Задачу вже тримає @bob/);
    sb.setBeat(0);
    assert.equal((await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) })).stdout, '');
    assert.equal(k.reqs.length, 2);
  });
});

for (const [name, act] of [
  ['новий begin', (sb, url) => begin(sb, url)],
  ['end', (sb, url) => run(sb, url, ['end', '--session', SID])],
]) {
  test(`відмову на повторний begin знімає ${name}`, async () => {
    let refuse = true;
    const handler = (r, reqs) => (reqs.length === 1 ? COLD : refuse ? LOST('Тримає @bob', null) : HELD);
    await withKando(handler, async (k) => {
      const sb = sandbox();
      await begin(sb, k.url);
      await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
      refuse = false;
      await act(sb, k.url);
      const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
      assert.equal(r.stdout, '');
    });
  });
}

// Перебирання вирішує людина, тож воно не відкладається: скіл зупиниться, а хук не сміє виконати
// його потім, коли людина вже думає, що нічого не сталось.
test('begin --takeover без відповіді: код 3, стану немає, хуки нічого не перебирають', async () => {
  await withKando(COLD, async (k) => {
    const sb = sandbox();
    const b = await begin(sb, k.url, ['--takeover']);
    assert.equal(b.code, 3);
    assert.match(b.stdout, /перебирання не підтверджено/);
    assert.ok(!fs.existsSync(sb.state()));
    assert.ok(!fs.existsSync(sb.state() + '.pending'));
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(k.reqs.length, 1);
  });
});

for (const status of [400, 401, 403]) {
  test(`begin --takeover: ${status} → код 3, бо задачу не перебрано й працювати далі не можна`, async () => {
    await withKando({ status, body: {} }, async (k) => {
      const sb = sandbox();
      const b = await begin(sb, k.url, ['--takeover']);
      assert.equal(b.code, 3);
      assert.ok(!fs.existsSync(sb.state()));
    });
  });
}

// Без коду 3 скіл читає результат як «працюй далі», поки задачу досі тримає інша сесія.
for (const [name, more, prep] of [
  ['немає токена', [], { token: null }],
  ['інший --repo', ['--repo', 'o/other'], {}],
  ['origin не на GitHub', [], { origin: 'https://gitlab.com/o/r.git' }],
]) {
  test(`begin --takeover: ${name} → код 3, перебирання не відбулось`, async () => {
    await withKando(HELD, async (k) => {
      const sb = sandbox(prep);
      assert.equal((await begin(sb, k.url, [...more, '--takeover'])).code, 3);
      assert.equal(k.reqs.length, 0);
      assert.equal((await begin(sb, k.url, more)).code, 0, 'без перебирання скіл працює далі');
    });
  });
}

test('begin --takeover: некоректний аргумент → код 3', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    const r = await run(sb, k.url, ['begin', '--session', 'a b', '--number', '7', '--skill', 'implement', '--takeover']);
    assert.equal(r.code, 3);
  });
});

test('begin --takeover: { managed: false } → код 0, тримача немає й перебирати нікого', async () => {
  await withKando({ status: 200, body: { managed: false } }, async (k) => {
    const sb = sandbox();
    assert.equal((await begin(sb, k.url, ['--takeover'])).code, 0);
  });
});

test('begin --takeover без відповіді не чіпає стан попередньої задачі', async () => {
  await withKando(COLD, async (k) => {
    const sb = sandbox();
    sb.writeState();
    const before = fs.readFileSync(sb.state(), 'utf8');
    await begin(sb, k.url, ['--takeover']);
    assert.equal(fs.readFileSync(sb.state(), 'utf8'), before);
  });
});

test('відмова на сам begin, коли висить .pending: хуки більше не беруть задачу, пуш заборонено', async () => {
  let refuse = true;
  const handler = (r, reqs) => (reqs.length === 1 ? COLD : refuse ? LOST('Тримає @bob', null) : HELD);
  await withKando(handler, async (k) => {
    const sb = sandbox();
    await begin(sb, k.url);
    const second = await begin(sb, k.url);
    assert.equal(second.code, 3);
    assert.ok(!fs.existsSync(sb.state() + '.pending'));
    refuse = false; // тримач закінчив, а скіл уже зупинився
    sb.setBeat(0);
    const count = k.reqs.length;
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(k.reqs.length, count, 'сесія не забирає задачу мовчки');
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /Тримає @bob/);
  });
});

test('begin у некерованому репо не знімає відмову й позначку з попередньої задачі', async () => {
  const handler = (r, reqs) => (reqs.length === 1 ? COLD : reqs.length === 2 ? LOST('Тримає @bob', null) : { status: 200, body: { managed: false } });
  await withKando(handler, async (k) => {
    const sb = sandbox();
    await begin(sb, k.url);
    await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
    assert.ok(fs.existsSync(sb.state() + '.refused'));
    await begin(sb, k.url);
    assert.ok(fs.existsSync(sb.state() + '.refused'));
  });
});

test('файли стану прибрано повністю: .refused не переживає кінець скіла й новий begin без відповіді', async () => {
  const handler = (r, reqs) => (reqs.length === 1 ? COLD : reqs.length === 2 ? LOST('Тримає @bob', null) : COLD);
  await withKando(handler, async (k) => {
    const sb = sandbox();
    await begin(sb, k.url);
    await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
    await begin(sb, k.url);
    assert.ok(!fs.existsSync(sb.state() + '.refused'), 'новий begin без відповіді');
    assert.ok(fs.existsSync(sb.state() + '.pending'));
    fs.writeFileSync(sb.state() + '.refused', 'x');
    await run(sb, k.url, ['end', '--session', SID]);
    assert.ok(!fs.existsSync(sb.state() + '.refused'), 'end');
  });
});

// Паралельний хук прочитав старий стан, поки begin іще в дорозі: сервер уже переніс рядок, а файл
// стану ще старий. Сесія нічого не втратила, тож ні зупинки, ні заборони.
for (const [hook, input] of [['post-tool', hookIn], ['pre-tool', (sb) => bashIn(sb, 'git push')]]) {
  test(`${hook}: lost moved → без попередження й заборони, стан лишається`, async () => {
    const moved = { status: 409, body: { managed: true, held: false, lost: 'moved', message: 'Ця сесія вже веде задачу #8.' } };
    await withKando(moved, async (k) => {
      const sb = sandbox();
      sb.writeState();
      const r = await run(sb, k.url, ['hook', hook], { stdin: input(sb) });
      assert.equal(r.stdout, '');
      assert.ok(fs.existsSync(sb.state()));
      assert.ok(!fs.existsSync(sb.state() + '.warned'));
    });
  });
}

// ─── відповідь розминулась зі зміною стану ───────────────────────────────────
// Хук відправив сигнал, а поки чекав відповідь, скіл закінчився й почався наступний. Сервер
// цієї гонки не бачить, тож звірити може лише скрипт: відповідь стосується старого стану.
function replaceStateDuring(sb, body, status = 409) {
  return () => {
    fs.writeFileSync(sb.state(), 'repo=o/r\nnumber=8\nskill=implement\n');
    return { status, body };
  };
}

test('пізня відповідь skill_done: стан наступної задачі лишається', async () => {
  const sb = sandbox();
  sb.writeState();
  await withKando(replaceStateDuring(sb, SKILL_DONE.body), async (k) => {
    const r = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(r.stdout, '');
    assert.ok(fs.readFileSync(sb.state(), 'utf8').includes('number=8'));
  });
});

test('той самий номер, інший скіл: пізня відповідь skill_done стан не видаляє', async () => {
  const sb = sandbox();
  sb.writeState();
  const handler = () => {
    fs.writeFileSync(sb.state(), 'repo=o/r\nnumber=7\nskill=feature-spec\n');
    return SKILL_DONE;
  };
  await withKando(handler, async (k) => {
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.ok(fs.existsSync(sb.state()));
  });
});

test('кожен begin дає інший файл стану: пізня відповідь не сплутає той самий номер і скіл', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    await begin(sb, k.url);
    const first = fs.readFileSync(sb.state(), 'utf8');
    await begin(sb, k.url);
    assert.notEqual(fs.readFileSync(sb.state(), 'utf8'), first);
  });
});

test('пізній 409 перед пушем: стара відповідь не забороняє команду нової задачі', async () => {
  const sb = sandbox();
  sb.writeState();
  await withKando(replaceStateDuring(sb, LOST().body), async (k) => {
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
    assert.equal(r.stdout, '');
  });
});

test('пізній 200: стара відповідь не знімає .pending нової задачі', async () => {
  const sb = sandbox();
  sb.writeState();
  fs.writeFileSync(sb.state() + '.pending', '');
  await withKando(replaceStateDuring(sb, HELD.body, 200), async (k) => {
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.ok(fs.existsSync(sb.state() + '.pending'));
  });
});

test('begin без відповіді після роботи над іншою задачею: старі .beat і .warned не глушать перший сигнал', async () => {
  await withKando(coldThenDone(), async (k) => {
    const sb = sandbox();
    sb.writeState();
    sb.setBeat(Math.floor(Date.now() / 1000));
    fs.writeFileSync(sb.state() + '.warned', '');
    await begin(sb, k.url);
    assert.ok(!fs.existsSync(sb.state() + '.warned'));
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(k.reqs.length, 2, 'перший сигнал не чекає 60 с');
    assert.equal(k.reqs[1].body.begin, true);
  });
});

test('успішний повторний begin прибирає позначку: наступний сигнал звичайний', async () => {
  await withKando((r, reqs) => (reqs.length === 1 ? COLD : HELD), async (k) => {
    const sb = sandbox();
    await begin(sb, k.url);
    assert.ok(fs.existsSync(sb.state() + '.pending'));
    await begin(sb, k.url);
    assert.ok(!fs.existsSync(sb.state() + '.pending'));
    sb.setBeat(Math.floor(Date.now() / 1000) - 61);
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.deepEqual(k.reqs[2].body, { repo: 'o/r', number: 7, skill: 'implement' });
  });
});

test('позначка не переживає кінець скіла й відхилений токен', async () => {
  await withKando((r, reqs) => (reqs.length === 1 ? COLD : { status: 200, body: {} }), async (k) => {
    const sb = sandbox();
    await begin(sb, k.url);
    await run(sb, k.url, ['end', '--session', SID]);
    assert.ok(!fs.existsSync(sb.state() + '.pending'));
  });
  await withKando((r, reqs) => (reqs.length === 1 ? COLD : { status: 401, body: {} }), async (k) => {
    const sb = sandbox();
    await begin(sb, k.url);
    await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.ok(!fs.existsSync(sb.state()));
    assert.ok(!fs.existsSync(sb.state() + '.pending'));
  });
});

test('post-tool: сервер не відповідає → порожній stdout, код 0, не довше за 6 с, стан лишається', async () => {
  await withKando('hang', async (k) => {
    const sb = sandbox();
    sb.writeState();
    const r = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.ok(r.ms < 6000, `хук тривав ${r.ms} мс`);
    assert.ok(fs.existsSync(sb.state()));
  });
});

// ─── hook pre-tool ───────────────────────────────────────────────────────────
const DENY = [
  'git push origin x', 'git -C . push', 'gh pr merge 5', 'gh pr create --title x',
  'cd sub\ngit push', 'echo a\ngit push origin x', 'npm test\ngh pr merge 5', 'echo a\n\tgit push',
  'git -c x=y push', 'cd x && git push', 'git --git-dir=.git push', 'git -C "my dir" push origin x',
  'gh pr --repo o/r merge 5', 'gh -R o/r pr close 3', 'true || git push', 'echo a | git push', 'FOO=1 git push',
  'echo "a\\"b" && git push',
  // Рядки, які посимвольний розбір пропускав: головне тут, що команду видно як підрядок.
  "cat > pr.md <<'EOF'\nрев'ю готове\nEOF\ngh pr create --body-file pr.md",
  "cat > n <<'EOF'\nрев'ю\nEOF\ngit push origin x", "# don't forget\ngit push",
  'npm test && \\\n  git push origin main', 'git \\\n  push origin main', 'gh pr \\\n  merge 5',
  'out="$(git push origin main 2>&1)"', 'echo "`git push`"', 'timeout 60 git push', 'env -i git push',
  'sudo -u me git push', 'nice git push', 'time -p git push', 'echo x | xargs git push', "bash -c 'git push'",
  'if a; then b; elif git push; then c; fi', '>/dev/null git push', '/usr/bin/git push', '/usr/local/bin/gh pr merge 5',
  'gh pr update-branch 5', 'gh pr reopen 5', 'gh pr comment 5 -b x', 'echo x | xargs gh pr merge',
  'echo pr merge 5 | xargs gh', 'echo push | xargs git', 'gh pr revert 5', 'gh pr lock 5', 'gh pr unlock 5',
];
for (const cmd of DENY) {
  test(`pre-tool: «${cmd}» + 409 → deny`, async () => {
    await withKando(LOST('Задачу тримає @bob'), async (k) => {
      const sb = sandbox();
      sb.writeState();
      const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, cmd) });
      const out = JSON.parse(r.stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /Задачу тримає @bob/);
      assertStopText(out.hookSpecificOutput.permissionDecisionReason);
      assert.ok(fs.existsSync(sb.state()), 'стан лишається, щоб перевірка блокувала й далі');
    });
  });
}

const PASS = [
  'git status', 'gh pr view 5', 'npm test', 'ls push', 'npm run push',
  'gh pr list', 'gh pr --repo o/r view 5', 'gh pr view 5 --json reviews,mergeable',
  'echo high priority', 'grep -r merge src', 'gh pr view pre-merge', 'gh pr checks x-review', 'gh issue close 5', 'git log --oneline',
];
for (const cmd of PASS) {
  test(`pre-tool: «${cmd}» → без запиту`, async () => {
    await withKando(LOST(), async (k) => {
      const sb = sandbox();
      sb.writeState();
      const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, cmd) });
      assert.equal(r.stdout, '');
      assert.equal(k.reqs.length, 0);
    });
  });
}

// Команда лише згадує пуш. Перевірка не вгадує, чи він виконається: питає сервер. Поки задача
// утримується, це лише зайвий запит, а хибна заборона можлива тільки в сесії, якій уже сказано зупинитись.
const MENTIONS = [
  'git commit -m "add push notifications"', 'git stash push', 'git log --grep=push',
  'git config push.default simple', 'git checkout -b fix/push-bug', 'git commit -m "x\ngit push"', 'echo "git push"',
];
for (const cmd of MENTIONS) {
  test(`pre-tool: «${cmd}» лише згадує пуш: задача утримується → команда йде`, async () => {
    await withKando(HELD, async (k) => {
      const sb = sandbox();
      sb.writeState();
      const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, cmd) });
      assert.equal(r.stdout, '');
      assert.equal(k.reqs.length, 1);
    });
  });
}
test('pre-tool: згадка пушу в сесії, що втратила задачу → заборонено', async () => {
  await withKando(LOST(), async (k) => {
    const sb = sandbox();
    sb.writeState();
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git commit -m "add push notifications"') });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
});

test('pre-tool: опис із «git push» (не command) не спрацьовує', async () => {
  await withKando(LOST(), async (k) => {
    const sb = sandbox();
    sb.writeState();
    const r = await run(sb, k.url, ['hook', 'pre-tool'], {
      stdin: hookIn(sb, { hook_event_name: 'PreToolUse', tool_input: { command: 'npm test', description: 'Run tests before git push' } }),
    });
    assert.equal(r.stdout, '');
    assert.equal(k.reqs.length, 0);
  });
});

test('pre-tool: cwd під /git/ і слово push у команді без git push → без запиту', async () => {
  await withKando(LOST(), async (k) => {
    const sb = sandbox({ underGit: true });
    sb.writeState();
    for (const cmd of ['ls push', 'npm run push']) {
      const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, cmd) });
      assert.equal(r.stdout, '');
    }
    assert.equal(k.reqs.length, 0);
  });
});

test('pre-tool: cwd іншого репо → git push без перевірки (gate hook_same_repo)', async () => {
  await withKando(LOST(), async (k) => {
    const sb = sandbox({ origin: 'git@github.com:other/thing.git' });
    sb.writeState(); // стан для o/r
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push origin x') });
    assert.equal(r.stdout, '');
    assert.equal(k.reqs.length, 0);
  });
});

test('вкладений tool_input.cwd не перекриває cwd верхнього рівня', async () => {
  await withKando(LOST(), async (k) => {
    const sb = sandbox();
    const other = sandbox({ origin: 'git@github.com:other/thing.git' });
    sb.writeState();
    const stdin = JSON.stringify({ session_id: SID, cwd: sb.cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'git push', cwd: other.cwd } });
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
});

test('pre-tool: 200 → без виводу', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    sb.writeState();
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push origin x') });
    assert.equal(r.stdout, '');
    assert.equal(k.reqs.length, 1);
  });
});

test('pre-tool: сервер не відповідає → без виводу, не довше за 6 с', async () => {
  await withKando('hang', async (k) => {
    const sb = sandbox();
    sb.writeState();
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.ok(r.ms < 6000, `хук тривав ${r.ms} мс`);
  });
});

// ─── довгі команди ───────────────────────────────────────────────────────────
// Хук має 6 с, тож перевірка не сміє рости разом із довжиною команди.
const UTF8 = { LC_ALL: 'en_US.UTF-8' };
const filler = (kb) => 'й'.repeat(kb * 512);
const heredoc = (kb, word = 'текст') => `cat > f.txt <<'EOF'\n${word} ${filler(kb)}\nEOF`;

test('pre-tool: 20 КБ без push і gh…pr → одразу вихід, без запиту', async () => {
  await withKando(LOST(), async (k) => {
    const sb = sandbox();
    sb.writeState();
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, heredoc(20)), env: UTF8 });
    assert.equal(r.stdout, '');
    assert.equal(k.reqs.length, 0);
    assert.ok(r.ms < 1500, `хук тривав ${r.ms} мс`);
  });
});

test('pre-tool: 20 КБ із багатьма gh, але без pr → одразу вихід, без запиту', async () => {
  await withKando(LOST(), async (k) => {
    const sb = sandbox();
    sb.writeState();
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'gh '.repeat(7000)), env: UTF8 });
    assert.equal(r.stdout, '');
    assert.equal(k.reqs.length, 0);
    assert.ok(r.ms < 1500, `хук тривав ${r.ms} мс`);
  });
});

for (const [name, word] of [['git push', 'git push'], ['gh pr merge', 'gh pr merge']]) {
  test(`pre-tool: 20 КБ із ${name} → питаємо сервер і встигаємо`, async () => {
    await withKando(LOST(), async (k) => {
      const sb = sandbox();
      sb.writeState();
      const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, heredoc(20, word)), env: UTF8 });
      assert.equal(k.reqs.length, 1);
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(r.ms < 1500, `хук тривав ${r.ms} мс`);
    });
  });
}

test('pre-tool: 20 КБ із git push, задача утримується → команда йде', async () => {
  await withKando(HELD, async (k) => {
    const sb = sandbox();
    sb.writeState();
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, heredoc(20, 'git push')), env: UTF8 });
    assert.equal(k.reqs.length, 1);
    assert.equal(r.stdout, '');
  });
});

test('pre-tool: без стану → без запиту', async () => {
  await withKando(LOST(), async (k) => {
    const sb = sandbox();
    const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push') });
    assert.equal(r.stdout, '');
    assert.equal(k.reqs.length, 0);
  });
});

// ─── hook session-end ────────────────────────────────────────────────────────
test('session-end: reason clear → DELETE session_end, стан видалено', async () => {
  await withKando({ status: 200, body: { ok: true } }, async (k) => {
    const sb = sandbox();
    sb.writeState();
    await run(sb, k.url, ['hook', 'session-end'], { stdin: hookIn(sb, { hook_event_name: 'SessionEnd', reason: 'clear' }) });
    assert.equal(k.reqs.length, 1);
    assert.equal(k.reqs[0].method, 'DELETE');
    assert.equal(k.reqs[0].url, `/api/agent/local-sessions/${SID}?reason=session_end`);
    assert.ok(!fs.existsSync(sb.state()));
  });
});

test('session-end: reason other → той самий DELETE, стан лишився', async () => {
  await withKando({ status: 200, body: { ok: true } }, async (k) => {
    const sb = sandbox();
    sb.writeState();
    await run(sb, k.url, ['hook', 'session-end'], { stdin: hookIn(sb, { hook_event_name: 'SessionEnd', reason: 'other' }) });
    assert.equal(k.reqs.length, 1);
    assert.equal(k.reqs[0].url, `/api/agent/local-sessions/${SID}?reason=session_end`);
    assert.ok(fs.existsSync(sb.state()));
  });
});

test('session-end: без стану → без запиту', async () => {
  await withKando({ status: 200, body: { ok: true } }, async (k) => {
    const sb = sandbox();
    await run(sb, k.url, ['hook', 'session-end'], { stdin: hookIn(sb, { reason: 'clear' }) });
    assert.equal(k.reqs.length, 0);
  });
});

// ─── end ─────────────────────────────────────────────────────────────────────
test('end: DELETE skill_done, стан видалено; повторний end не падає', async () => {
  await withKando({ status: 200, body: { ok: true } }, async (k) => {
    const sb = sandbox();
    sb.writeState();
    sb.setBeat(1);
    const r = await run(sb, k.url, ['end', '--session', SID]);
    assert.equal(r.code, 0);
    assert.equal(k.reqs[0].method, 'DELETE');
    assert.equal(k.reqs[0].url, `/api/agent/local-sessions/${SID}?reason=skill_done`);
    assert.ok(!fs.existsSync(sb.state()));
    assert.ok(!fs.existsSync(sb.state() + '.beat'));
    const r2 = await run(sb, k.url, ['end', '--session', SID]);
    assert.equal(r2.code, 0);
  });
});

// ─── секрети ─────────────────────────────────────────────────────────────────
test('токен не потрапляє в аргументи curl і не друкується', async () => {
  await withKando(LOST(), async (k) => {
    const sb = sandbox({ token: 'SECRET-TOKEN-VALUE' });
    sb.writeState();
    // Обгортка curl, що пише свої аргументи у файл і виконує справжній curl.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-bin-'));
    const real = spawnSync('which', ['curl'], { encoding: 'utf8' }).stdout.trim();
    const log = path.join(bin, 'argv.log');
    tmpDirs.push(bin);
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    const PATH = `${bin}:${process.env.PATH}`;
    const outs = [
      await begin(sb, k.url, [], { path: PATH }),
      await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb), path: PATH }),
      await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push'), path: PATH }),
      await run(sb, k.url, ['hook', 'session-end'], { stdin: hookIn(sb), path: PATH }),
    ];
    assert.ok(fs.existsSync(log), 'обгортка curl мала спрацювати');
    const argv = fs.readFileSync(log, 'utf8');
    assert.ok(!argv.includes('SECRET-TOKEN-VALUE'), 'токен в argv curl');
    // таймаути -m: begin 20, post-tool 5, pre-tool 5, session-end 4
    const tmo = [...argv.matchAll(/^-m\n(\d+)$/gm)].map((m) => m[1]);
    assert.deepEqual(tmo, ['20', '5', '5', '4']);
    for (const o of outs) assert.ok(!(o.stdout + o.stderr).includes('SECRET-TOKEN-VALUE'));
    assert.ok(k.reqs.every((r) => r.auth === 'Bearer SECRET-TOKEN-VALUE'), 'токен усе ж мав дійти до сервера');
  });
});

// ─── hooks.json ──────────────────────────────────────────────────────────────
test('hooks.json: обгортка hooks, три хуки через CLAUDE_PLUGIN_ROOT з таймаутами 6/6/5', () => {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin', 'hooks', 'hooks.json'), 'utf8'));
  const h = j.hooks;
  const cmd = (e) => h[e][0].hooks[0];
  assert.match(cmd('PostToolUse').command, /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/kando-session"? hook post-tool/);
  assert.match(cmd('PreToolUse').command, /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/kando-session"? hook pre-tool/);
  assert.match(cmd('SessionEnd').command, /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/kando-session"? hook session-end/);
  assert.equal(h.PreToolUse[0].matcher, 'Bash');
  assert.equal(h.PostToolUse[0].matcher, undefined);
  assert.deepEqual([cmd('PostToolUse').timeout, cmd('PreToolUse').timeout, cmd('SessionEnd').timeout], [6, 6, 5]);
});
