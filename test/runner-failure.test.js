const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { failurePath, writeFailure, tailBuffer } = require('../src/runner/failure');
const { runSetup } = require('../src/runner/setup');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kando-failure-'));
const sink = () => { const chunks = []; return { chunks, write: c => { chunks.push(String(c)); return true; } }; };
// Справжній вивід — у файл, як у журнал job: фонові процеси тримають його, а не крок.
// text() — без службових ::group:: (у них текст команди).
const fileSink = () => {
  const file = path.join(tmp(), 'log');
  const fd = fs.openSync(file, 'a');
  return { fd, write: c => { fs.writeSync(fd, String(c)); return true; }, text: () => fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.startsWith('::')).join('\n') };
};

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
  const out = fileSink(), err = fileSink();
  await assert.rejects(
    runSetup({ envJson: '{"setup":["echo one; echo two >&2; exit 3"]}', out, err, env }),
    /«echo one; echo two >&2; exit 3» завершилась з кодом 3/,
  );
  const f = JSON.parse(fs.readFileSync(failurePath(env), 'utf8'));
  assert.equal(f.stage, 'setup');
  assert.equal(f.exit_code, 3);
  assert.equal(f.command, 'echo one; echo two >&2; exit 3');
  assert.ok(f.tail.includes('one') && f.tail.includes('two'));
  assert.match(out.text(), /one/);
  assert.match(err.text(), /two/);
});

test('runSetup: успіх не створює failure.json', async () => {
  const dir = tmp();
  const env = { RUNNER_TEMP: dir };
  await runSetup({ envJson: '{"setup":["echo hi"]}', out: sink(), err: sink(), env });
  assert.equal(fs.existsSync(failurePath(env)), false);
});

test('writeFailure: command > 500 і довгий tail-рядок обрізаються, exit_code ≤ 20', () => {
  const env = { RUNNER_TEMP: tmp() };
  writeFailure(env, { stage: 'setup', command: 'c'.repeat(600), exit_code: 'E'.repeat(40), tail: ['t'.repeat(700)] });
  const f = JSON.parse(fs.readFileSync(failurePath(env), 'utf8'));
  assert.equal(f.command.length, 500);
  assert.equal(f.exit_code.length, 20);
  assert.equal(f.tail[0].length, 500);
});

test('tailBuffer: кириличний символ, розрізаний між шматками, лишається цілим', () => {
  const t = tailBuffer();
  const b = Buffer.from('привіт\n');
  t.push(b.subarray(0, 3));
  t.push(b.subarray(3));
  assert.deepEqual(t.lines(), ['привіт']);
});

test('tailBuffer: \\r-прогрес лишає текст після останнього \\r (і в незавершеному рядку)', () => {
  const t = tailBuffer();
  t.push('10%\r20%\r30%\n40%\r50%');
  assert.deepEqual(t.lines(), ['30%', '50%']);
});

test('tailBuffer: незавершені рядки stdout і stderr не склеюються', () => {
  const t = tailBuffer();
  const so = t.stream(), se = t.stream();
  so.push('out-part');
  se.push('err-line\n');
  so.push('-end\n');
  assert.deepEqual(t.lines(), ['err-line', 'out-part-end']);
});

test('tailBuffer: величезний рядок без \\n обмежено', () => {
  const t = tailBuffer();
  t.push('x'.repeat(100000));
  t.push('y'.repeat(100000));
  assert.equal(t.lines()[0].length, 500);
});

test('runSetup: помилка запуску дає exit_code ENOENT (≤ 20), повне повідомлення в tail', async () => {
  const { EventEmitter } = require('node:events');
  const env = { RUNNER_TEMP: tmp() };
  const spawn = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    setImmediate(() => p.emit('error', Object.assign(new Error('spawn bash ENOENT: no such file ' + 'z'.repeat(50)), { code: 'ENOENT' })));
    return p;
  };
  const sk = sink();
  await assert.rejects(runSetup({ envJson: '{"setup":["x"]}', spawn, out: sk, err: sk, env }), /завершилась з кодом ENOENT/);
  const f = JSON.parse(fs.readFileSync(failurePath(env), 'utf8'));
  assert.equal(f.exit_code, 'ENOENT');
  assert.match(f.tail.join('\n'), /no such file/);
});

test('runSetup: збій запису failure.json не підміняє помилку setup', async () => {
  const blocker = path.join(tmp(), 'file');
  fs.writeFileSync(blocker, 'x');
  const env = { RUNNER_TEMP: blocker }; // mkdir під файлом -> ENOTDIR
  const sk = sink();
  await assert.rejects(runSetup({ envJson: '{"setup":["exit 2"]}', out: sk, err: sk, env }), /«exit 2» завершилась з кодом 2/);
});

test('tailBuffer: CRLF-рядки не стають порожніми', () => {
  const t = tailBuffer();
  t.push('foo\r\nbar\r\n');
  assert.deepEqual(t.lines(), ['foo', 'bar']);
  const t2 = tailBuffer();
  t2.push('10%\r20%\r\n');
  assert.deepEqual(t2.lines(), ['20%']);
});

test('fitFailure: малий звіт без змін; великий — без найстаріших рядків tail', () => {
  const { fitFailure } = require('../src/runner/failure');
  const small = { stage: 'setup', command: 'x', exit_code: 1, tail: ['a', 'b'] };
  assert.deepEqual(fitFailure(small), small);
  const big = { ...small, tail: Array.from({ length: 150 }, (_, i) => `${i} ` + 'ї'.repeat(490)) };
  const fit = fitFailure(big);
  assert.ok(Buffer.byteLength(JSON.stringify(fit), 'utf8') <= 48 * 1024);
  assert.equal(fit.tail.at(-1), big.tail.at(-1));
  assert.deepEqual(fit.tail, big.tail.slice(-fit.tail.length));
  assert.equal(big.tail.length, 150); // вхід не змінено
});

test('runSetup: фоновий процес не тримає крок (sleep 6 & echo started)', async () => {
  const env = { RUNNER_TEMP: tmp() };
  const out = fileSink(), err = fileSink();
  const t0 = Date.now();
  await runSetup({ envJson: JSON.stringify({ setup: ['sleep 6 & echo started'] }), out, err, env });
  assert.ok(Date.now() - t0 < 2000, `тривало ${Date.now() - t0} мс`);
  assert.match(out.text(), /started/);
});

test('runSetup: збій — tail має stdout і stderr команди, вивід живий у out/err', async () => {
  const env = { RUNNER_TEMP: tmp() };
  const out = fileSink(), err = fileSink();
  await assert.rejects(
    runSetup({ envJson: JSON.stringify({ setup: ['echo out-line; echo err-line >&2; exit 4'] }), out, err, env }),
    /«echo out-line; echo err-line >&2; exit 4» завершилась з кодом 4/,
  );
  const f = JSON.parse(fs.readFileSync(failurePath(env), 'utf8'));
  assert.equal(f.exit_code, 4);
  assert.ok(f.tail.includes('out-line') && f.tail.includes('err-line'), JSON.stringify(f.tail));
  assert.match(out.text(), /out-line/);
  assert.doesNotMatch(out.text(), /err-line/);
  assert.match(err.text(), /err-line/);
});

test('runSetup: синтаксична помилка рядка потрапляє в tail, семантика bash -e та сама', async () => {
  const env = { RUNNER_TEMP: tmp() };
  const out = fileSink(), err = fileSink();
  await assert.rejects(runSetup({ envJson: JSON.stringify({ setup: ['false; echo never'] }), out, err, env }), /кодом 1/);
  assert.doesNotMatch(out.text(), /never/);
  const env2 = { RUNNER_TEMP: tmp() };
  await assert.rejects(runSetup({ envJson: JSON.stringify({ setup: ['echo "unterminated'] }), out, err, env: env2 }), /кодом 2/);
  const f = JSON.parse(fs.readFileSync(failurePath(env2), 'utf8'));
  assert.match(f.tail.join('\n'), /unexpected EOF/);
});

test('runSetup: дочірній bash не успадковує перехоплення виводу', async () => {
  const env = { RUNNER_TEMP: tmp() };
  const out = fileSink(), err = fileSink();
  await runSetup({ envJson: JSON.stringify({ setup: ['bash -c "echo inner"; echo "env=[${BASH_ENV:-}]"'] }), out, err, env });
  const text = out.text();
  assert.equal(text.split('inner').length - 1, 1, text);
  assert.match(text, /env=\[\]/);
});
