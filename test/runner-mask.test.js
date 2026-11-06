const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mask, secretsFrom } = require('../src/runner/mask');

const b64 = s => Buffer.from(s).toString('base64');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kando-mask-'));

test('mask: точне значення секрету всередині рядка → ***', () => {
  assert.equal(mask('curl -u tok-SECRET-123 host', ['tok-SECRET-123']), 'curl -u *** host');
});

test('mask: довше значення маскується першим, спецсимволи не ламають розбір', () => {
  assert.equal(mask('a.b*c+d and a.b', ['a.b', 'a.b*c+d']), '*** and ***');
});

test('mask: кожен шаблон токена → ***', () => {
  for (const t of ['ghs_abc123', 'ghp_abc123', 'gho_abc123', 'ghu_abc123', 'github_pat_abc_123', 'sk-ant-api03-abc_123', 'Bearer abc.def']) {
    const out = mask(`x ${t} y`, []);
    assert.ok(!out.includes('abc'), `${t} → ${out}`);
    assert.match(out, /\*\*\*/);
  }
  assert.equal(mask('Authorization: token zzz\nnext', []), '***\nnext');
});

test('secretsFrom: змінні, токен-файл і рядки файлів ≥ 8; короткі й порожні відкинуто', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'kando'));
  fs.writeFileSync(path.join(dir, 'kando', 'token'), 'ghs_filetoken\n');
  const files = JSON.stringify({ '.env': b64('A=1\nDB_PASSWORD=hunter2hunter2\n\n   \n') });
  const env = { RUNNER_TEMP: dir, KANDO_MASK_CLAUDE_TOKEN: 'claude-secret', KANDO_MASK_API_KEY: '   ', KANDO_MASK_FILES: files };
  const s = secretsFrom(env);
  assert.deepEqual(new Set(s), new Set(['claude-secret', 'ghs_filetoken', 'DB_PASSWORD=hunter2hunter2']));
  const line = mask('log: DB_PASSWORD=hunter2hunter2 A=1', s);
  assert.equal(line, 'log: *** A=1');
});

test('secretsFrom: битий KANDO_MASK_FILES → без файлових значень, без винятку', () => {
  const s = secretsFrom({ RUNNER_TEMP: tmp(), KANDO_MASK_CLAUDE_TOKEN: 'claude-secret', KANDO_MASK_FILES: '{not json' });
  assert.deepEqual(s, ['claude-secret']);
});

test('mask: префікс секрету, обрізаного на межі рядка, теж маскується', () => {
  const secret = 'S3CRET-token-value-0123456789';
  const line = ('x'.repeat(490) + secret).slice(0, 500);   // у рядок влізло лише 10 символів секрету
  const out = mask(line, [secret]);
  assert.equal(out, 'x'.repeat(490) + '***');
  assert.equal(mask('x'.repeat(495) + 'S3CRE', [secret]), 'x'.repeat(495) + 'S3CRE', 'коротше 8 — не чіпаємо');
});
