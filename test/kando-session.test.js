const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'plugin', 'bin', 'kando-session');
const SID = 'abc-123';

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

function sandbox({ token = 'tok-secret', origin = 'git@github.com:o/r.git' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ks repo '));
  if (token) {
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

test('begin: сервер не відповідає → код 0, стан записано, вкладається в таймаут', async () => {
  await withKando('hang', async (k) => {
    const sb = sandbox();
    const r = await begin(sb, k.url, [], { env: { KANDO_BEGIN_TIMEOUT: '2' } });
    assert.equal(r.code, 0);
    assert.ok(r.ms < 6000, `begin тривав ${r.ms} мс`);
    assert.ok(fs.existsSync(sb.state()));
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

for (const status of [401, 403]) {
  test(`post-tool: ${status} → стан видалено`, async () => {
    await withKando({ status, body: { error: 'x' } }, async (k) => {
      const sb = sandbox();
      sb.writeState();
      const r = await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb) });
      assert.equal(r.stdout, '');
      assert.ok(!fs.existsSync(sb.state()));
    });
  });
}

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
for (const cmd of ['git push origin x', 'git -C . push', 'gh pr merge 5', 'gh pr create --title x']) {
  test(`pre-tool: «${cmd}» + 409 → deny`, async () => {
    await withKando(LOST('Задачу тримає @bob'), async (k) => {
      const sb = sandbox();
      sb.writeState();
      const r = await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, cmd) });
      const out = JSON.parse(r.stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /Задачу тримає @bob/);
      assert.ok(fs.existsSync(sb.state()), 'стан лишається, щоб перевірка блокувала й далі');
    });
  });
}

for (const cmd of ['git status', 'gh pr view 5', 'npm test']) {
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
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    const PATH = `${bin}:${process.env.PATH}`;
    const outs = [
      await begin(sb, k.url, [], { path: PATH }),
      await run(sb, k.url, ['hook', 'post-tool'], { stdin: hookIn(sb), path: PATH }),
      await run(sb, k.url, ['hook', 'pre-tool'], { stdin: bashIn(sb, 'git push'), path: PATH }),
      await run(sb, k.url, ['hook', 'session-end'], { stdin: hookIn(sb), path: PATH }),
    ];
    assert.ok(fs.existsSync(log), 'обгортка curl мала спрацювати');
    assert.ok(!fs.readFileSync(log, 'utf8').includes('SECRET-TOKEN-VALUE'), 'токен в argv curl');
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
