const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { missingTools, preflight } = require('../src/runner/preflight');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const SCRIPT = path.join(ROOT, 'src', 'runner', 'preflight.js');
const actionYml = fs.readFileSync(path.join(ROOT, 'runner', 'action.yml'), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kando-preflight-'));
const silent = { log: () => {} };

// Фейковий spawn: ключ — назва програми, значення — що вона повертає. Виклики записує.
function fakeSpawn(results = {}) {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args]);
    return results[cmd] ?? { status: 0 };
  };
  spawn.calls = calls;
  return spawn;
}

const script = (dir, name, body) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
};

// Каталог лише з тим, що потрібно самій обгортці bin/gh. Системні /usr/bin і /bin у PATH не
// кладемо: там може лежати справжній gh (на ubuntu-раннері GitHub він у /usr/bin).
function shellOnlyDir(root) {
  const dir = path.join(root, 'shell');
  fs.mkdirSync(dir);
  for (const name of ['bash', 'cat', 'dirname']) {
    const found = ['/bin', '/usr/bin'].map(d => path.join(d, name)).find(p => fs.existsSync(p));
    fs.symlinkSync(found, path.join(dir, name));
  }
  return dir;
}

test('missingTools: перевіряє саме запуском git --version, gh --version, unzip -v', () => {
  const spawn = fakeSpawn();
  assert.deepEqual(missingTools({ env: {}, spawn }), []);
  assert.deepEqual(spawn.calls, [['git', '--version'], ['gh', '--version'], ['unzip', '-v']]);
});

test('missingTools: ненульовий код означає, що утиліти немає', () => {
  const spawn = fakeSpawn({ gh: { status: 127 } });
  assert.deepEqual(missingTools({ env: {}, spawn }), ['gh']);
});

test('missingTools: помилка запуску (ENOENT) і таймаут теж означають, що утиліти немає', () => {
  const spawn = fakeSpawn({
    git: { status: null, error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) },
    unzip: { status: null, signal: 'SIGTERM' },
  });
  assert.deepEqual(missingTools({ env: {}, spawn }), ['git', 'unzip']);
});

test('missingTools: передає env дочірньому процесу (там PATH з обгорткою gh)', () => {
  const seen = [];
  const env = { PATH: '/x' };
  missingTools({ env, spawn: (cmd, args, opts) => { seen.push(opts.env); return { status: 0 }; } });
  assert.deepEqual(seen, [env, env, env]);
});

test('missingTools: обгортка bin/gh без справжнього gh не вважається утилітою', () => {
  const root = tmp();
  const shell = shellOnlyDir(root);
  const tools = path.join(root, 'tools');
  script(tools, 'git', 'exit 0');
  script(tools, 'unzip', 'exit 0');
  const PATH = [BIN, tools, shell].join(':');

  // `command -v gh` знаходить обгортку: саме тому перевірка йде запуском.
  const lookup = spawnSync(path.join(shell, 'bash'), ['-c', 'command -v gh'], { encoding: 'utf8', env: { PATH } });
  assert.equal(lookup.stdout.trim(), path.join(BIN, 'gh'));

  assert.deepEqual(missingTools({ env: { PATH } }), ['gh']);
});

test('missingTools: обгортка bin/gh зі справжнім gh проходить перевірку', () => {
  const root = tmp();
  const shell = shellOnlyDir(root);
  const tools = path.join(root, 'tools');
  script(tools, 'git', 'exit 0');
  script(tools, 'unzip', 'exit 0');
  script(tools, 'gh', 'exit 0');
  assert.deepEqual(missingTools({ env: { PATH: [BIN, tools, shell].join(':') } }), []);
});

test('preflight: усе є → порожній вихід missing і без помилки', () => {
  const out = {};
  preflight({ env: {}, spawn: fakeSpawn(), setOutput: (k, v) => { out[k] = v; }, log: silent });
  assert.deepEqual(out, { missing: '' });
});

test('preflight: чогось бракує → вихід missing через пробіл і помилка з назвами', () => {
  const out = {};
  const spawn = fakeSpawn({ gh: { status: 127 }, unzip: { status: 127 } });
  assert.throws(
    () => preflight({ env: {}, spawn, setOutput: (k, v) => { out[k] = v; }, log: silent }),
    /gh, unzip/,
  );
  assert.deepEqual(out, { missing: 'gh unzip' });
});

test('preflight.js як скрипт: бракує утиліти → код 1, ::error:: і запис у GITHUB_OUTPUT', () => {
  const root = tmp();
  const shell = shellOnlyDir(root);
  const tools = path.join(root, 'tools');
  script(tools, 'git', 'exit 0');
  script(tools, 'gh', 'exit 0');
  const output = path.join(root, 'output');
  fs.writeFileSync(output, '');
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: [tools, shell].join(':'), GITHUB_OUTPUT: output },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /::error::.*unzip/);
  assert.match(fs.readFileSync(output, 'utf8'), /^missing<<(\S+)\nunzip\n\1\n$/);
});

test('preflight.js як скрипт: усе є → код 0, вихід missing порожній', () => {
  const root = tmp();
  const shell = shellOnlyDir(root);
  const tools = path.join(root, 'tools');
  for (const name of ['git', 'gh', 'unzip']) script(tools, name, 'exit 0');
  const output = path.join(root, 'output');
  fs.writeFileSync(output, '');
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: [tools, shell].join(':'), GITHUB_OUTPUT: output },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(output, 'utf8'), /^missing<<(\S+)\n\n\1\n$/);
});

test('action.yml: preflight після setup і перед claude_install', () => {
  const at = id => actionYml.indexOf(`- id: ${id}\n`);
  assert.ok(at('preflight') > 0);
  assert.ok(at('preflight') > at('setup'));
  assert.ok(at('preflight') < at('claude_install'));
  assert.match(actionYml, /src\/runner\/preflight\.js/);
});

test('action.yml: перелік утиліт іде в крок finish через env', () => {
  const finishStep = actionYml.slice(actionYml.indexOf('- id: finish\n'));
  assert.match(finishStep, /MISSING_TOOLS: \$\{\{ steps\.preflight\.outputs\.missing \}\}/);
});

test('action.yml: крок preflight без умови always — його збій пропускає Claude', () => {
  const step = actionYml.slice(actionYml.indexOf('- id: preflight\n'), actionYml.indexOf('- id: claude_install\n'));
  assert.doesNotMatch(step, /if:|continue-on-error/);
});

test('кроки до preflight (start, files, heartbeat) не викликають gh — відсутній gh не обриває їх раніше', () => {
  for (const f of ['start.js', 'files.js', 'heartbeat.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'runner', f), 'utf8');
    assert.doesNotMatch(src, /(spawn|exec)\w*\(\s*['"`]gh['"`]/, f);
  }
});
