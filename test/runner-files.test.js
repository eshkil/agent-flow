const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeFiles } = require('../src/runner/files');

const FILES_JS = path.join(__dirname, '..', 'src', 'runner', 'files.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kando-files-'));
const b64 = s => Buffer.from(s).toString('base64');
const secretJson = obj => JSON.stringify(obj);

// Усе, що є в теці (файли й теки), відносними шляхами.
const tree = dir => fs.readdirSync(dir, { recursive: true }).sort();

test('writeFiles: валідний набір пише файли з вмістом і правами 0600, створює теки', () => {
  const root = tmp();
  const out = writeFiles(secretJson({ '.env': b64('A=1\n'), 'app/google-services.json': b64('{"k":"v"}') }), root);
  assert.deepEqual(out.sort(), ['.env', 'app/google-services.json']);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'A=1\n');
  assert.equal(fs.readFileSync(path.join(root, 'app', 'google-services.json'), 'utf8'), '{"k":"v"}');
  for (const f of ['.env', 'app/google-services.json']) assert.equal(fs.statSync(path.join(root, f)).mode & 0o777, 0o600);
});

test('writeFiles: існуючий файл перезаписується і отримує 0600', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.env'), 'old', { mode: 0o644 });
  writeFiles(secretJson({ '.env': b64('new') }), root);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'new');
  assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600);
});

test('writeFiles: порожнє, відсутнє й «{}» → []', () => {
  const root = tmp();
  for (const v of ['', '   \n', undefined, null, '{}']) assert.deepEqual(writeFiles(v, root), []);
  assert.deepEqual(tree(root), []);
});

test('writeFiles: небезпечні шляхи → помилка, нічого не записано (навіть валідні файли поруч)', () => {
  const bad = ['../x', '/etc/x', '.git/config', 'a/../../x', 'a/../b', './a', 'a//b', 'a\\b', 'a/\u0001b', '.GIT/config',
    'sub/.Git/hooks/pre-commit', '.git./config', '.git /config', '.git', 'a/.git/', '', '..'];
  for (const p of bad) {
    const root = tmp();
    assert.throws(() => writeFiles(secretJson({ ok: b64('1'), [p]: b64('2') }), root), /files: /, `шлях ${JSON.stringify(p)}`);
    assert.deepEqual(tree(root), [], `для ${JSON.stringify(p)} нічого не мало бути записано`);
  }
});

test('writeFiles: symlink на теку поза root → помилка, нічого не записано', () => {
  const root = tmp();
  const outside = tmp();
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => writeFiles(secretJson({ fine: b64('1'), 'link/new/.env': b64('2') }), root), /symlink|виходить/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.ok(!fs.existsSync(path.join(root, 'fine')));
});

test('writeFiles: symlink на файл поза root не перезаписується', () => {
  const root = tmp();
  const outside = tmp();
  const victim = path.join(outside, 'victim');
  fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, path.join(root, '.env'));
  assert.throws(() => writeFiles(secretJson({ '.env': b64('x') }), root), /symlink/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
});

test('writeFiles: symlink-теки всередині root дозволені, root сам може бути symlink-ом', () => {
  const real = tmp();
  const root = path.join(tmp(), 'ws');
  fs.symlinkSync(real, root);
  fs.mkdirSync(path.join(real, 'a'));
  fs.symlinkSync(path.join(real, 'a'), path.join(real, 'alias'));
  assert.deepEqual(writeFiles(secretJson({ 'alias/.env': b64('1') }), root), ['alias/.env']);
  assert.equal(fs.readFileSync(path.join(real, 'a', '.env'), 'utf8'), '1');
});

test('writeFiles: шлях через звичайний файл → помилка', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'f'), '');
  assert.throws(() => writeFiles(secretJson({ 'f/x': b64('1') }), root), /файл/);
});

test('writeFiles: невалідний JSON і не-обʼєкт → помилка без вмісту', () => {
  const root = tmp();
  const secret = 'SUPERSECRETVALUE';
  for (const v of [`{"a": "${secret}`, `not json ${secret}`, `["${secret}"]`, '"str"', 'null1']) {
    assert.throws(() => writeFiles(v, root), e => {
      assert.match(e.message, /KANDO_FILES/);
      assert.ok(!e.message.includes(secret));
      return true;
    });
  }
});

test('writeFiles: вміст не в base64 → помилка без вмісту, нічого не записано', () => {
  const root = tmp();
  const secret = b64('TOPSECRET');
  assert.throws(() => writeFiles(secretJson({ ok: secret, bad: 'не base64!' }), root), e => {
    assert.match(e.message, /"bad".*base64/);
    assert.ok(!e.message.includes('base64!') && !e.message.includes(secret));
    return true;
  });
  assert.throws(() => writeFiles(secretJson({ n: 5 }), root), /base64/);
  assert.deepEqual(tree(root), []);
});

test('writeFiles: помилка шляху не містить вмісту файлу', () => {
  const root = tmp();
  const content = b64('TOPSECRET');
  assert.throws(() => writeFiles(secretJson({ '../x': content }), root), e => !e.message.includes(content));
});

test('writeFiles: ключ __proto__ — звичайний шлях (тут валідний), а не втрачений', () => {
  const root = tmp();
  assert.deepEqual(writeFiles('{"__proto__": "' + b64('p') + '"}', root), ['__proto__']);
  assert.equal(fs.readFileSync(path.join(root, '__proto__'), 'utf8'), 'p');
});

// ─── як скрипт кроку ─────────────────────────────────────────────────────────
function runScript(env) {
  return spawnSync(process.execPath, [FILES_JS], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
}

test('скрипт: пише у GITHUB_WORKSPACE, у лог лише шляхи — без вмісту й base64', () => {
  const root = tmp();
  const content = b64('TOPSECRET=1');
  const r = runScript({ GITHUB_WORKSPACE: root, KANDO_FILES_JSON: secretJson({ '.env': content }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\.env/);
  assert.ok(!(r.stdout + r.stderr).includes(content) && !(r.stdout + r.stderr).includes('TOPSECRET'));
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'TOPSECRET=1');
});

test('скрипт: без GITHUB_WORKSPACE пише в cwd; порожній input — тихий успіх', () => {
  const cwd = tmp();
  const r = spawnSync(process.execPath, [FILES_JS], { cwd, env: { PATH: process.env.PATH, KANDO_FILES_JSON: secretJson({ 'x/y': b64('1') }) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(cwd, 'x', 'y')));
  const empty = runScript({ GITHUB_WORKSPACE: tmp(), KANDO_FILES_JSON: '' });
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, '');
});

test('скрипт: поганий шлях → ::error::, код 1, нічого не записано, вміст не в логу', () => {
  const root = tmp();
  const content = b64('TOPSECRET');
  const r = runScript({ GITHUB_WORKSPACE: root, KANDO_FILES_JSON: secretJson({ ok: content, '../x': content }) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^::error::files: /);
  assert.ok(!(r.stdout + r.stderr).includes(content));
  assert.deepEqual(tree(root), []);
});

// ─── підключення в action.yml / шаблоні ─────────────────────────────────────
test('action.yml: input files необовʼязковий, крок files між heartbeat і setup, значення лише через env', () => {
  const y = fs.readFileSync(path.join(__dirname, '..', 'runner', 'action.yml'), 'utf8');
  assert.match(y, /\n  files:\n    description:.*\n    required: false\n    default: ''/);
  const steps = [...y.matchAll(/^    - id: (\w+)/gm)].map(m => m[1]);
  assert.deepEqual(steps.slice(0, 4), ['start', 'heartbeat', 'files', 'setup']);
  const step = y.slice(y.indexOf('    - id: files'), y.indexOf('    - id: setup'));
  assert.match(step, /KANDO_FILES_JSON: \$\{\{ inputs\.files \}\}/);
  assert.match(step, /run: node "\$GITHUB_ACTION_PATH\/\.\.\/src\/runner\/files\.js"/);
  assert.ok(!/run:[^\n]*\$\{\{/.test(step), 'інпут не підставляється в run');
});

test('шаблон kando-agent.yml передає секрет KANDO_FILES у input files раннера v2', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'templates', 'kando-agent.yml'), 'utf8');
  assert.ok(t.includes('files: ${{ secrets.KANDO_FILES }}'));
  assert.ok(t.indexOf('anthropic_api_key:') < t.indexOf('files: ${{ secrets.KANDO_FILES }}'));
});
