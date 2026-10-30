// Спільне для кроків раннера режиму C: OIDC-токен Actions (доказ особи для Kando),
// запити до API Kando з повторами та безпечний запис токена GitHub у файл.

const fs = require('node:fs');
const path = require('node:path');

const AUDIENCE = 'kando-agent';
const ATTEMPTS = 3;
const RETRY_MS = 5000;

// Паузи між спробами /finish: від 5 с, удвічі, не більше хвилини, разом рівно
// 10 хв. Підсумок — єдиний звіт про роботу: рестарт чи деплой Kando не має
// перетворити готовий запуск на «обірваний».
const FINISH_TOTAL_MS = 10 * 60e3;
const FINISH_DELAYS = (() => {
  const out = [];
  let next = RETRY_MS, total = 0;
  while (total < FINISH_TOTAL_MS) {
    const d = Math.min(next, 60e3, FINISH_TOTAL_MS - total);
    out.push(d);
    total += d;
    next *= 2;
  }
  return out;
})();

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
// delays — паузи між спробами (інакше attempts спроб через retryMs). oidc — рядок
// або функція: довгим повторам потрібен свіжий токен на кожну спробу.
async function call(kandoUrl, route, body, { oidc, fetchImpl = fetch, sleep = sleepMs, retryMs = RETRY_MS, attempts = ATTEMPTS, delays }) {
  const url = `${String(kandoUrl).replace(/\/+$/, '')}${route}`;
  const waits = delays || Array(Math.max(attempts - 1, 0)).fill(retryMs);
  let last;
  for (let i = 0; i <= waits.length; i++) {
    try {
      const bearer = typeof oidc === 'function' ? await oidc() : oidc;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
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
    if (i < waits.length) await sleep(waits[i]);
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

// Конфіг git лише на цей job — через GIT_CONFIG_COUNT/KEY_n/VALUE_n у $GITHUB_ENV.
// У ~/.gitconfig раннера (на Mac він живе у справжнього користувача) не пишемо нічого.
//  1. Порожній credential.helper скидає helper-и системного/глобального конфігу
//     (osxkeychain), далі наш helper віддає свіжий токен з файлу.
//  2. claude-code-action переписує origin на https://x-access-token:<токен старту>@github.com/…,
//     тож git ніколи не питав би helper і після ~години пуші падали б зі старим токеном.
//     insteadOf прибирає токен з URL, і git іде до helper-а.
function gitConfigEnv({ env = {}, helper, startToken }) {
  const entries = [
    ['credential.helper', ''],
    ['credential.helper', helper],
    ['url.https://github.com/.insteadOf', `https://x-access-token:${startToken}@github.com/`],
  ];
  const base = Number.parseInt(env.GIT_CONFIG_COUNT, 10);
  const from = Number.isInteger(base) && base > 0 ? base : 0;
  const out = { GIT_CONFIG_COUNT: String(from + entries.length) };
  entries.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${from + i}`] = key;
    out[`GIT_CONFIG_VALUE_${from + i}`] = value;
  });
  return out;
}

module.exports = { gitConfigEnv, AUDIENCE, ATTEMPTS, RETRY_MS, FINISH_DELAYS, paths, oidcToken, call, writeToken, KandoError };
