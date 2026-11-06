const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { failurePath, writeFailure, tailBuffer } = require('../src/runner/failure');
const { runSetup } = require('../src/runner/setup');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kando-failure-'));
const sink = () => { const chunks = []; return { chunks, write: c => { chunks.push(String(c)); return true; } }; };

test('tailBuffer: 200 рядків → останні 150', () => {
  const t = tailBuffer();
  for (let i = 1; i <= 200; i++) t.push(`line ${i}\n`);
  const lines = t.lines();
  assert.equal(lines.length, 150);
  assert.equal(lines[0], 'line 51');
  assert.equal(lines[149], 'line 200');
});

test('tailBuffer: шматки посеред рядка склеюються, незавершений рядок зберігається', () => {
  const t = tailBuffer();
  t.push(Buffer.from('hel'));
  t.push('lo\nwor');
  t.push('ld');
  assert.deepEqual(t.lines(), ['hello', 'world']);
});

test('tailBuffer: ANSI знято, рядки з :: пропущено, довгий рядок до 500', () => {
  const t = tailBuffer();
  t.push('\x1b[31mred\x1b[0m\n::group::x\nok\n' + 'a'.repeat(600) + '\n');
  const lines = t.lines();
  assert.deepEqual(lines.slice(0, 2), ['red', 'ok']);
  assert.equal(lines[2].length, 500);
  assert.equal(lines.length, 3);
});

test('failurePath: у $RUNNER_TEMP/kando', () => {
  assert.equal(failurePath({ RUNNER_TEMP: '/x' }), '/x/kando/failure.json');
});

test('writeFailure: пише JSON з runner_os/arch, права 0600; другий виклик не перезаписує', () => {
  const dir = tmp();
  const env = { RUNNER_TEMP: dir, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' };
  assert.equal(writeFailure(env, { stage: 'setup', command: 'x', exit_code: 1, tail: ['a'] }), true);
  assert.equal(writeFailure(env, { stage: 'files', command: null, exit_code: null, tail: ['b'] }), false);
  const file = failurePath(env);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    stage: 'setup', command: 'x', exit_code: 1, tail: ['a'], runner_os: 'Linux', runner_arch: 'X64',
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('runSetup: збій пише failure.json, вивід іде і в out/err', async () => {
  const dir = tmp();
  const env = { RUNNER_TEMP: dir, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' };
  const out = sink(), err = sink();
  await assert.rejects(
    runSetup({ envJson: '{"setup":["echo one; echo two >&2; exit 3"]}', out, err, env }),
    /«echo one; echo two >&2; exit 3» завершилась з кодом 3/,
  );
  const f = JSON.parse(fs.readFileSync(failurePath(env), 'utf8'));
  assert.equal(f.stage, 'setup');
  assert.equal(f.exit_code, 3);
  assert.equal(f.command, 'echo one; echo two >&2; exit 3');
  assert.ok(f.tail.includes('one') && f.tail.includes('two'));
  assert.match(out.chunks.join(''), /one/);
  assert.match(err.chunks.join(''), /two/);
});

test('runSetup: успіх не створює failure.json', async () => {
  const dir = tmp();
  const env = { RUNNER_TEMP: dir };
  await runSetup({ envJson: '{"setup":["echo hi"]}', out: sink(), err: sink(), env });
  assert.equal(fs.existsSync(failurePath(env)), false);
});
