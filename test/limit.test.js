const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectLimit, readMessages } = require('../src/limit');

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

test('detectLimit (сторонні провайдери): 429 / rate_limit_error / quota / balance / credits / usage limit → limited: true', () => {
  const cases = [
    ['deepseek', 'API Error: 429 Too Many Requests'],
    ['deepseek', 'Insufficient Balance: please top up your account'],
    ['zai', 'rate_limit_error: requests per minute exceeded'],
    ['zai', 'Quota exceeded for current plan'],
    ['openrouter', 'HTTP 429: Insufficient credits on OpenRouter'],
    ['openrouter', 'Monthly usage limit has been reached'],
    ['deepseek', 'Daily limit reached'],
    ['openrouter', 'You hit your limit for today'],
  ];
  for (const [provider, text] of cases) {
    const r = detectLimit([init, result({ is_error: true, result: text })], { provider });
    assert.deepEqual(r, { limited: true, until: null }, `${provider}: ${text}`);
  }
});

test('detectLimit (сторонні провайдери): assistant з error та rate_limit_event rejected', () => {
  const asstErr = {
    type: 'assistant',
    error: 'api_error',
    message: { role: 'assistant', content: [{ type: 'text', text: '429 Too many requests' }] },
  };
  assert.deepEqual(detectLimit([init, asstErr], { provider: 'deepseek' }), { limited: true, until: null });
  assert.deepEqual(detectLimit([init, assistantErr], { provider: 'zai' }), { limited: true, until: null });

  const withEvent = detectLimit([init, rle('rejected', 1760461200000)], { provider: 'openrouter' });
  assert.equal(withEvent.limited, true);
  assert.equal(withEvent.until.toISOString(), '2025-10-14T17:00:00.000Z');
});

test('detectLimit (сторонні провайдери): витягання until із Retry-After (сек / HTTP-дата), ISO-дати, resetsAt (сек / мс)', () => {
  const now = Date.parse('2026-11-26T12:00:00.000Z');

  const retrySec = detectLimit(
    [init, result({ is_error: true, result: '429 Too Many Requests. Retry-After: 120' })],
    { provider: 'deepseek', now }
  );
  assert.equal(retrySec.limited, true);
  assert.equal(retrySec.until.toISOString(), '2026-11-26T12:02:00.000Z');

  const retryHttp = detectLimit(
    [init, result({ is_error: true, result: '429 Too Many Requests; Retry-After: Thu, 26 Nov 2026 14:30:00 GMT.' })],
    { provider: 'openrouter', now }
  );
  assert.equal(retryHttp.limited, true);
  assert.equal(retryHttp.until.toISOString(), '2026-11-26T14:30:00.000Z');

  const iso = detectLimit(
    [init, result({ is_error: true, result: 'Quota exceeded, resets at 2026-11-26T18:00:00Z' })],
    { provider: 'zai', now }
  );
  assert.equal(iso.limited, true);
  assert.equal(iso.until.toISOString(), '2026-11-26T18:00:00.000Z');

  const resetsSec = detectLimit(
    [init, result({ is_error: true, result: 'rate_limit_error {"resetsAt": 1760461200}' })],
    { provider: 'deepseek', now }
  );
  assert.equal(resetsSec.limited, true);
  assert.equal(resetsSec.until.toISOString(), '2025-10-14T17:00:00.000Z');

  const resetsMs = detectLimit(
    [init, result({ is_error: true, result: 'rate_limit_error', resetsAt: 1760461200000 })],
    { provider: 'openrouter', now }
  );
  assert.equal(resetsMs.limited, true);
  assert.equal(resetsMs.until.toISOString(), '2025-10-14T17:00:00.000Z');
});

test('detectLimit (сторонні провайдери): немає хибних спрацьовувань на успіху, тексті assistant без помилки та звичайних помилках', () => {
  // Успішний результат, що згадує 429 і rate_limit_error.
  assert.deepEqual(
    detectLimit([init, result({ is_error: false, result: 'Додав обробку 429 Too Many Requests та insufficient balance' })], { provider: 'deepseek' }),
    { limited: false, until: null }
  );
  // Звичайне повідомлення assistant без поля error + звичайна помилка 500 у result.
  const normalAssistant = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Обробляємо HTTP 429 і rate_limit_error' }] },
  };
  assert.deepEqual(
    detectLimit([init, normalAssistant, result({ is_error: true, result: 'HTTP 500 Internal Server Error: SyntaxError at line 4290' })], { provider: 'openrouter' }),
    { limited: false, until: null }
  );
  // Для claude поведінка не змінилася: 429 без rate_limit_event / LIMIT_TEXT не вважається лімітом.
  assert.deepEqual(
    detectLimit([init, result({ is_error: true, result: 'API Error: 429 Insufficient balance' })], { provider: 'claude' }),
    { limited: false, until: null }
  );
});
