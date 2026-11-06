// Крок finish (if: always()): зупиняє heartbeat і доповідає Kando про підсумок.
// Лейблів і коментарів тут немає — це робить Kando за відповіддю /finish.

const fs = require('node:fs');
const { detectLimit, readMessages } = require('../limit');
const { failurePath, fitFailure } = require('./failure');
const { secretsFrom, mask } = require('./mask');
const { paths, oidcToken, call, KandoError, FINISH_DELAYS } = require('./kando');

// steps.claude.outcome: success | failure | cancelled | skipped.
// skipped (збій setup тощо) для Kando — той самий збій.
const outcomeOf = v => (v === 'success' || v === 'cancelled' ? v : 'failure');

// Скіли знімають ai:in-progress наприкінці; якщо він лишився — сесія обірвалась.
async function isStuck({ env, numbers, fetchImpl = fetch, log = console }) {
  if (!numbers.length) return false;
  let token;
  try { token = fs.readFileSync(paths(env).token, 'utf8').trim(); } catch { return false; }
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  for (const n of numbers) {
    try {
      const res = await fetchImpl(`${api}/repos/${env.GITHUB_REPOSITORY}/issues/${n}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!res.ok) { log.log(`finish: #${n} не прочитано (HTTP ${res.status})`); continue; }
      const item = await res.json();
      if ((item.labels || []).some(l => (l.name ?? l) === 'ai:in-progress')) return true;
    } catch (e) {
      log.log(`finish: #${n} не прочитано (${e.message})`);
    }
  }
  return false;
}

// Звіт про збій кроку раннера (failure.json), замаскований. Немає файла чи він битий —
// null: /finish піде без поля. Вміст ніколи не логуємо.
function readFailure(env) {
  try {
    const raw = fs.readFileSync(failurePath(env), 'utf8');
    const report = JSON.parse(raw);
    if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
    // Маскуємо значення, а не сирий JSON: шаблон Authorization забирає рядок до кінця
    // і зламав би розмітку.
    const secrets = secretsFrom(env);
    const walk = v => typeof v === 'string' ? mask(v, secrets) : Array.isArray(v) ? v.map(walk) : v;
    return Object.fromEntries(Object.entries(report).map(([k, v]) => [k, walk(v)]));
  } catch { return null; }
}

async function finish({ env, fetchImpl = fetch, sleep, delays = FINISH_DELAYS, log = console }) {
  const p = paths(env);
  // Спершу зупиняємо heartbeat: після /finish він отримав би лише 409.
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(p.stop, '');

  const outcome = outcomeOf(env.CLAUDE_OUTCOME);
  const limit = outcome === 'failure' ? detectLimit(readMessages(env.EXECUTION_FILE)) : { limited: false, until: null };
  const numbers = [...new Set([env.ISSUE, env.PR].map(Number).filter(n => Number.isInteger(n) && n > 0))];
  const stuck = await isStuck({ env, numbers, fetchImpl, log });

  // Перелік із кроку preflight: причину з командою встановлення будує Kando.
  const missing = (env.MISSING_TOOLS || '').split(/\s+/).filter(Boolean);

  const body = { outcome, limit: { limited: limit.limited, until: limit.until ? limit.until.toISOString() : null }, stuck };
  if (missing.length) Object.assign(body, { missing, runner_os: env.RUNNER_OS });
  if (outcome === 'failure') {
    const failure = readFailure(env);
    // Після маскування: у межах ліміту Kando, щоб великий tail не зламав увесь /finish.
    if (failure) body.failure = fitFailure(failure);
  }
  // Перший токен — одразу: без змінних Actions повторювати нема чого. Далі кожна
  // спроба бере новий (OIDC-токен живе кілька хвилин, а повтори — до 10 хв).
  let first = await oidcToken(env, fetchImpl);
  const oidc = async () => {
    const t = first ?? await oidcToken(env, fetchImpl);
    first = null;
    return t;
  };
  const res = await call(env.KANDO_URL, `/api/agent/runs/${env.KANDO_RUN_ID}/finish`, body, { oidc, fetchImpl, sleep, delays });
  log.log(`Kando: підсумок ${outcome}${stuck ? ' (завис ai:in-progress)' : ''}${limit.limited ? ' (ліміт Claude)' : ''}${missing.length ? ` (немає утиліт: ${missing.join(', ')})` : ''} → ${res.status}`);
  return { body, res };
}

if (require.main === module) {
  finish({ env: process.env }).catch(e => {
    // 409 — сторож чи скасування вже закрили запуск: звітувати нема кому.
    if (e instanceof KandoError && e.status === 409) { console.log(`finish: ${e.message}`); return; }
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}

module.exports = { finish, isStuck, outcomeOf };
