// Спільне для кроків раннера режиму C: OIDC-токен Actions (доказ особи для Kando),
// запити до API Kando з повторами та безпечний запис токена GitHub у файл.

const fs = require('node:fs');
const path = require('node:path');

const AUDIENCE = 'kando-agent';
const ATTEMPTS = 3;
const RETRY_MS = 5000;

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

// Усі файли раннера лежать в одному каталозі; його ж читають bin/gh і credential helper.
function paths(env) {
  const dir = env.KANDO_DIR || path.join(env.RUNNER_TEMP || '/tmp', 'kando');
  return { dir, token: path.join(dir, 'token'), stop: path.join(dir, 'stop'), log: path.join(dir, 'heartbeat.log') };
}

async function oidcToken(env, fetchImpl = fetch) {
  const base = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!base || !bearer) throw new Error('Немає ACTIONS_ID_TOKEN_REQUEST_*: workflow потребує permissions: id-token: write');
  const url = new URL(base);
  url.searchParams.set('audience', AUDIENCE);
  const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`OIDC-токен Actions: HTTP ${res.status}`);
  const { value } = await res.json();
  if (!value) throw new Error('OIDC-токен Actions: порожня відповідь');
  return value;
}

class KandoError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// 5xx і мережа — повторюємо (Kando міг рестартувати), 4xx — відповідь остаточна.
async function call(kandoUrl, route, body, { oidc, fetchImpl = fetch, sleep = sleepMs, retryMs = RETRY_MS, attempts = ATTEMPTS }) {
  const url = `${String(kandoUrl).replace(/\/+$/, '')}${route}`;
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${oidc}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      last = new KandoError(res.status, `${route}: HTTP ${res.status}${data?.error ? ` — ${data.error}` : ''}`);
      if (res.status < 500) throw last;
    } catch (e) {
      if (e instanceof KandoError && e.status < 500) throw e;
      last = e instanceof KandoError ? e : new KandoError(0, `${route}: ${e.message}`);
    }
    if (i < attempts) await sleep(retryMs);
  }
  throw last;
}

// Тимчасовий файл + rename: читач (bin/gh, git) ніколи не побачить напівзаписаний токен.
function writeToken(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

module.exports = { AUDIENCE, ATTEMPTS, RETRY_MS, paths, oidcToken, call, writeToken, KandoError };
