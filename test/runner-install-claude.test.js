// Окрема копія Claude Code на запуск: кілька runner-ів на одному сервері ділять $HOME і
// перезаписували один одному файл завантаження. Встановлювач тут підроблений, curl не викликається.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pinnedVersion, installClaude, main } = require('../src/runner/install-claude');

const SCRIPT = path.join(__dirname, '..', 'src', 'runner', 'install-claude.js');
const actionYml = fs.readFileSync(path.join(__dirname, '..', 'runner', 'action.yml'), 'utf8');
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-')); dirs.push(d); return d; };
const quiet = { log() {} };

// Дерево _actions: наш runner і claude-code-action поруч, як на диску runner-а.
function actionsTree(version = '2.1.318') {
  const root = tmp();
  const runner = path.join(root, 'eshkil', 'agent-flow', 'v2', 'runner');
  fs.mkdirSync(runner, { recursive: true });
  if (version !== null) {
    const dir = path.join(root, 'anthropics', 'claude-code-action', 'v1', 'src', 'entrypoints');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.ts'), `  const claudeCodeVersion = "${version}";\n`);
  }
  return runner;
}

// spawn встановлювача: кладе виконуваний файл у $HOME цього виклику.
const okSpawn = (calls, out = '2.1.318 (Claude Code)\n') => (cmd, args, opts) => {
  if (args[0] === '--version') return { status: 0, stdout: out };
  calls.push({ cmd, args, opts });
  const bin = path.join(opts.env.HOME, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '');
  return { status: 0 };
};

test('pinnedVersion: версія з коду дії; немає файла чи сміття → null', () => {
  assert.equal(pinnedVersion(actionsTree('2.1.318')), '2.1.318');
  assert.equal(pinnedVersion(actionsTree(null)), null);
  assert.equal(pinnedVersion(actionsTree('1.0; rm -rf')), null);
  assert.equal(pinnedVersion(''), null);
});

test('installClaude: ставить у теку всередині RUNNER_TEMP, справжній HOME не чіпає', () => {
  const temp = tmp();
  const calls = [];
  const exe = installClaude({ version: '2.1.318', runnerTemp: temp, spawn: okSpawn(calls), log: quiet });
  assert.equal(exe, path.join(temp, 'kando-claude-home', '.local', 'bin', 'claude'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.env.HOME, path.join(temp, 'kando-claude-home'));
  assert.notEqual(calls[0].opts.env.HOME, process.env.HOME);
  assert.match(calls[0].args[1], /set -o pipefail; curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash -s -- 2\.1\.318$/);
});

test('installClaude: два запуски на одному сервері не ділять теку завантаження', () => {
  const calls = [];
  const a = installClaude({ version: '2.1.318', runnerTemp: tmp(), spawn: okSpawn(calls), log: quiet });
  const b = installClaude({ version: '2.1.318', runnerTemp: tmp(), spawn: okSpawn(calls), log: quiet });
  assert.notEqual(a, b);
  assert.notEqual(calls[0].opts.env.HOME, calls[1].opts.env.HOME);
});

test('installClaude: збій — ще одна спроба, потім null', () => {
  const calls = [];
  const fail = (...a) => { calls.push(a); return { status: 1 }; };
  assert.equal(installClaude({ version: '2.1.318', runnerTemp: tmp(), spawn: fail, log: quiet }), null);
  assert.equal(calls.length, 2);
});

test('installClaude: версія копії не збігається → не успіх', () => {
  const calls = [];
  assert.equal(installClaude({ version: '2.1.318', runnerTemp: tmp(), spawn: okSpawn(calls, '2.0.1 (Claude Code)'), log: quiet }), null);
  assert.equal(calls.length, 2);
});

test('installClaude: код 0, але файла немає → не успіх', () => {
  assert.equal(installClaude({ version: '2.1.318', runnerTemp: tmp(), spawn: () => ({ status: 0 }), log: quiet }), null);
});

function mainEnv(version = '2.1.318') {
  const output = path.join(tmp(), 'out');
  fs.writeFileSync(output, '');
  return { GITHUB_ACTION_PATH: actionsTree(version), RUNNER_TEMP: tmp(), GITHUB_OUTPUT: output };
}

test('main: успіх — шлях у вихід кроку', () => {
  const env = mainEnv();
  main({ env, log: quiet, install: () => '/tmp/x/claude' });
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'path=/tmp/x/claude\n');
});

for (const [name, version, install] of [
  ['версію не визначено', null, () => { throw new Error('не мало викликатись'); }],
  ['встановлення не вдалось', '2.1.318', () => null],
  ['виняток під час встановлення', '2.1.318', () => { throw new Error('диск повний'); }],
]) {
  test(`main: ${name} → без шляху й без падіння, дія поставить сама`, () => {
    const env = mainEnv(version);
    const lines = [];
    main({ env, log: { log: l => lines.push(l) }, install });
    assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), '');
    assert.ok(lines.some(l => l.startsWith('::warning::')));
  });
}

test('скрипт: збій встановлювача не валить крок (код 0, порожній вихід)', async () => {
  const env = mainEnv();
  const bin = tmp();
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/bash\nexit 22\n', { mode: 0o755 });
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp(), ...env }, stdio: 'ignore',
    });
    p.on('close', resolve);
  });
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), '');
});

test('action.yml: окрема копія ставиться після setup і передається claude-code-action', () => {
  const at = id => actionYml.indexOf(`- id: ${id}\n`);
  assert.ok(at('claude_install') > at('setup'));
  assert.ok(at('claude_install') < at('claude'));
  assert.match(actionYml, /path_to_claude_code_executable: \$\{\{ steps\.claude_install\.outputs\.path \}\}/);
  assert.match(actionYml, /src\/runner\/install-claude\.js/);
});
