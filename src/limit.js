// Ознака ліміту підписки Claude з журналу сесії, що вже відбулася: execution_file
// claude-code-action — масив SDK-повідомлень. Жодних запитів до Claude.
// Основне джерело — rate_limit_event зі status 'rejected' і resetsAt (секунди епохи);
// запасне — повідомлення assistant з error 'rate_limit' або текст результату
// про ліміт (тоді час відновлення невідомий).

const fs = require('node:fs');

const LIMIT_TEXT = /usage limit|limit reached|hit your limit/i;
const NONE = Object.freeze({ limited: false, until: null });

function readMessages(file) {
  if (!file) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const isEvent = m => m?.type === 'rate_limit_event' && m.rate_limit_info;

function untilOf(info) {
  const s = Number(info?.resetsAt);
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000) : null;
}

function detectLimit(messages) {
  const events = messages.filter(isEvent);
  const last = events.at(-1);
  if (last?.rate_limit_info.status === 'rejected') {
    return { limited: true, until: untilOf(last.rate_limit_info) };
  }
  const result = messages.findLast(m => m?.type === 'result');
  const errored = messages.some(m => m?.type === 'assistant' && m.error === 'rate_limit')
    || (result?.is_error && LIMIT_TEXT.test(String(result.result || '')));
  if (!errored) return NONE;
  // Остання подія могла бути вже «allowed_warning», а відмова — без події:
  // беремо час з останньої відмови, якщо вона була.
  const rejected = events.findLast(m => m.rate_limit_info.status === 'rejected');
  return { limited: true, until: rejected ? untilOf(rejected.rate_limit_info) : null };
}

// Для журналу запуску: лише службові повідомлення про ліміт, без тексту сесії,
// щоб побачити реальний формат і не вивантажувати розмову агента.
function limitExtract(messages) {
  const clip = s => String(s ?? '').slice(0, 500);
  return messages.flatMap(m => {
    if (isEvent(m)) return [{ type: m.type, rate_limit_info: m.rate_limit_info }];
    if (m?.type === 'assistant' && m.error) {
      const text = (m.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      return [{ type: 'assistant', error: m.error, text: clip(text) }];
    }
    if (m?.type === 'result') {
      return [{ type: 'result', subtype: m.subtype, is_error: m.is_error, result: m.is_error ? clip(m.result) : undefined }];
    }
    return [];
  });
}

function formatUntil(date, timeZone) {
  const fmt = tz => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(p => [p.type, p.value]));
    return `${parts.day}.${parts.month} о ${parts.hour}:${parts.minute} (${tz})`;
  };
  try {
    return fmt(timeZone || 'UTC');
  } catch {
    return fmt('UTC');
  }
}

module.exports = { detectLimit, readMessages, limitExtract, formatUntil };
