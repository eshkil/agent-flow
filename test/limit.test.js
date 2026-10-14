const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectLimit, readMessages, limitExtract, formatUntil } = require('../src/limit');

// Форма повідомлень — як у execution_file claude-code-action (масив SDK-повідомлень).
const init = { type: 'system', subtype: 'init', session_id: 's' };
const rle = (status, resetsAt, extra = {}) => ({
  type: 'rate_limit_event', session_id: 's', uuid: 'u',
  rate_limit_info: { status, ...(resetsAt !== undefined && { resetsAt }), rateLimitType: 'five_hour', ...extra },
});
const limitText = 'You’ve hit your limit · resets 5pm (UTC)';
const assistantErr = {
  type: 'assistant', error: 'rate_limit', session_id: 's',
  message: { role: 'assistant', content: [{ type: 'text', text: limitText }] },
};
const result = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'Готово', ...over });

test('detectLimit: rate_limit_event rejected з resetsAt → ліміт і час', () => {
  const r = detectLimit([init, rle('allowed'), rle('rejected', 1760461200), assistantErr, result({ is_error: true, result: limitText })]);
  assert.equal(r.limited, true);
  assert.equal(r.until.toISOString(), '2025-10-14T17:00:00.000Z');
});

test('detectLimit: ліміт без часу (лише текст результату) → ліміт без until', () => {
  const r = detectLimit([init, result({ is_error: true, result: 'Claude AI usage limit reached' })]);
  assert.deepEqual(r, { limited: true, until: null });
});

test('detectLimit: помилка assistant rate_limit без події → ліміт без until', () => {
  const r = detectLimit([init, assistantErr, result({ is_error: true, result: limitText })]);
  assert.deepEqual(r, { limited: true, until: null });
});

test('detectLimit: подія rejected раніше, а остання — allowed → ліміту немає', () => {
  const r = detectLimit([init, rle('rejected', 1760461200), rle('allowed'), result()]);
  assert.deepEqual(r, { limited: false, until: null });
});

test('detectLimit: assistant rate_limit + подія rejected раніше → час із неї', () => {
  const r = detectLimit([init, rle('rejected', 1760461200), rle('allowed_warning'), assistantErr]);
  assert.equal(r.limited, true);
  assert.equal(r.until.toISOString(), '2025-10-14T17:00:00.000Z');
});

test('detectLimit: звичайна помилка → ліміту немає', () => {
  const r = detectLimit([init, rle('allowed'), result({ subtype: 'error_during_execution', is_error: true, result: 'Tool failed: ENOENT' })]);
  assert.deepEqual(r, { limited: false, until: null });
});

test('detectLimit: успіх → ліміту немає; порожній журнал теж', () => {
  assert.deepEqual(detectLimit([init, rle('allowed_warning'), result()]), { limited: false, until: null });
  assert.deepEqual(detectLimit([]), { limited: false, until: null });
});

test('readMessages: файл з масивом / відсутній / зіпсований', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-limit-'));
  const ok = path.join(dir, 'ok.json');
  fs.writeFileSync(ok, JSON.stringify([init, result()]));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{не json');
  assert.equal(readMessages(ok).length, 2);
  assert.deepEqual(readMessages(path.join(dir, 'нема.json')), []);
  assert.deepEqual(readMessages(bad), []);
  assert.deepEqual(readMessages(''), []);
});

test('limitExtract: лише службові повідомлення про ліміт, без тексту сесії', () => {
  const tool = { type: 'user', message: { content: [{ type: 'tool_result', content: 'секретний вивід' }] } };
  const ex = limitExtract([init, tool, rle('rejected', 1760461200), assistantErr, result({ is_error: true, result: limitText })]);
  assert.deepEqual(ex.map(m => m.type), ['rate_limit_event', 'assistant', 'result']);
  assert.ok(!JSON.stringify(ex).includes('секретний'));
});

test('formatUntil: дата й час у заданій зоні; невідома зона → UTC', () => {
  const d = new Date('2025-10-14T17:00:00Z');
  assert.equal(formatUntil(d, 'Europe/Kyiv'), '14.10 о 20:00 (Europe/Kyiv)');
  assert.equal(formatUntil(d, 'UTC'), '14.10 о 17:00 (UTC)');
  assert.equal(formatUntil(d, 'Нема/Такої'), '14.10 о 17:00 (UTC)');
  assert.equal(formatUntil(d, ''), '14.10 о 17:00 (UTC)');
});
