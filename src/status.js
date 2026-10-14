// Стан ліміту Claude для Kando (POST status_url). Формат і перевірка —
// eshkil/kando-board backend/routes/github.js (agentStatus): тіло
// {ts, repo, status: 'ok'|'limit', until?}, HMAC-SHA256 сирого тіла спільним
// секретом у заголовку X-Agent-Signature-256. Збій відправки лише логуємо:
// він не має впливати на ai:failed і результат кроку.

const crypto = require('node:crypto');

async function sendStatus({ url, secret, repo, status, until = null, now = Date.now(), fetchImpl = fetch, timeoutMs = 10_000, log = console }) {
  if (!url) return false;
  if (!secret) {
    log.warn('agent-status: status_url задано без status_secret — статус не надіслано');
    return false;
  }
  const body = JSON.stringify({ ts: now, repo, status, ...(until && { until: until.toISOString() }) });
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Signature-256': signature },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn(`agent-status: ${url} відповів ${res.status}`);
      return false;
    }
    log.log(`agent-status: надіслано «${status}»`);
    return true;
  } catch (e) {
    log.warn(`agent-status: не вдалося надіслати — ${e.message}`);
    return false;
  }
}

module.exports = { sendStatus };
