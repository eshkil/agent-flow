// Ознака ліміту підписки/квоти з журналу сесії, що вже відбулася: execution_file
// (масив SDK-повідомлень). Жодних запитів до API.
// Для Claude: rate_limit_event зі status 'rejected' і resetsAt (секунди епохи),
// запасне — assistant з error 'rate_limit' або текст результату про ліміт.
// Для сторонніх провайдерів (DeepSeek / Z.ai / OpenRouter тощо): додатково
// розпізнаємо помилки 429 / квоти / балансу та витягаємо час відновлення з
// resetsAt, Retry-After або ISO-дати.

const fs = require('node:fs');

const LIMIT_TEXT = /usage limit|limit reached|hit your limit/i;
const PROVIDER_LIMIT_TEXT = /\b429\b|rate_limit_error|too[\s_-]+many[\s_-]+requests|quota[\s_-]+exceeded|insufficient[\s_-]+(?:balance|credits)|usage limit|limit reached|hit your limit/i;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/;
const RESETS_AT_TEXT_RE = /"?resets[_-]?at"?\s*[:=]\s*"?(\d{9,16}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))"?/i;
const RETRY_AFTER_HTTP_RE = /retry[-_]after["']?\s*[:=]\s*["']?([A-Za-z]{3},\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/i;
const RETRY_AFTER_SEC_RE = /retry[-_]after["']?\s*[:=]\s*["']?(\d+)(?:\s*s(?:ec(?:onds?)?)?)?\b/i;
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

function parseEpoch(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  if (Number.isFinite(n) && n > 0) {
    return new Date(n > 1e12 ? n : n * 1000);
  }
  if (typeof val === 'string') {
    const ts = Date.parse(val);
    if (Number.isFinite(ts)) return new Date(ts);
  }
  return null;
}

function untilOf(info) {
  return parseEpoch(info?.resetsAt);
}

function parseRetryAfter(val, now) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
    return new Date(now + val * 1000);
  }
  const str = String(val).trim();
  if (/^\d+$/.test(str)) {
    return new Date(now + Number(str) * 1000);
  }
  const ts = Date.parse(str);
  return Number.isFinite(ts) ? new Date(ts) : null;
}

function messageText(m) {
  const parts = [];
  if (typeof m.error === 'string') parts.push(m.error);
  if (typeof m.result === 'string') parts.push(m.result);
  if (Array.isArray(m.errors)) {
    for (const e of m.errors) if (typeof e === 'string') parts.push(e);
  }
  if (typeof m.message === 'string') {
    parts.push(m.message);
  } else if (m.message && typeof m.message === 'object') {
    if (typeof m.message.content === 'string') {
      parts.push(m.message.content);
    } else if (Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (typeof block?.text === 'string') parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

function extractUntil(msg, text, now) {
  const structuredReset = parseEpoch(msg?.resetsAt ?? msg?.resets_at ?? msg?.rate_limit_info?.resetsAt);
  if (structuredReset) return structuredReset;

  const resetMatch = text.match(RESETS_AT_TEXT_RE);
  if (resetMatch) {
    const parsed = parseEpoch(resetMatch[1]);
    if (parsed) return parsed;
  }

  const structuredRetry = parseRetryAfter(
    msg?.retry_after ?? msg?.retryAfter ?? msg?.headers?.['retry-after'] ?? msg?.headers?.['Retry-After'],
    now
  );
  if (structuredRetry) return structuredRetry;

  const httpRetry = text.match(RETRY_AFTER_HTTP_RE);
  if (httpRetry) {
    const parsed = parseRetryAfter(httpRetry[1], now);
    if (parsed) return parsed;
  }

  const secRetry = text.match(RETRY_AFTER_SEC_RE);
  if (secRetry) {
    const parsed = parseRetryAfter(secRetry[1], now);
    if (parsed) return parsed;
  }

  const isoMatch = text.match(ISO_DATE_RE);
  if (isoMatch) {
    const ts = Date.parse(isoMatch[0]);
    if (Number.isFinite(ts)) return new Date(ts);
  }

  return null;
}

function detectClaudeLimit(messages) {
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

function detectProviderLimit(messages, now) {
  const events = messages.filter(isEvent);
  const lastEvent = events.at(-1);
  if (lastEvent?.rate_limit_info.status === 'rejected') {
    return { limited: true, until: untilOf(lastEvent.rate_limit_info) };
  }

  const errorCandidates = [];
  for (const m of messages) {
    if (m?.type === 'assistant' && (m.error || m.is_error === true)) {
      errorCandidates.push(m);
    }
  }
  const lastResult = messages.findLast(m => m?.type === 'result');
  if (lastResult && (lastResult.is_error === true || lastResult.error)) {
    errorCandidates.push(lastResult);
  }

  const matched = [];
  for (const m of errorCandidates) {
    const text = messageText(m);
    if (m.error === 'rate_limit' || PROVIDER_LIMIT_TEXT.test(text)) {
      matched.push({ m, text });
    }
  }
  if (!matched.length) return NONE;

  for (let i = matched.length - 1; i >= 0; i--) {
    const until = extractUntil(matched[i].m, matched[i].text, now);
    if (until) return { limited: true, until };
  }
  const rejected = events.findLast(m => m.rate_limit_info.status === 'rejected');
  return { limited: true, until: rejected ? untilOf(rejected.rate_limit_info) : null };
}

function detectLimit(messages, { provider = 'claude', now = Date.now() } = {}) {
  if (!Array.isArray(messages) || !messages.length) return NONE;
  const normalized = String(provider || 'claude').trim().toLowerCase() || 'claude';
  if (normalized === 'claude') return detectClaudeLimit(messages);
  return detectProviderLimit(messages, now);
}

module.exports = { detectLimit, readMessages };
