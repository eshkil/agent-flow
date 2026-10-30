// Фоновий процес: кожну хвилину каже Kando «я живий» і отримує свіжий токен GitHub
// (токен живе годину, а сесія може тривати довше). Heartbeat ніколи не валить job:
// мережеві збої лише логуються, наступний тік повторить. Зупиняється, коли Kando
// каже, що запуск закінчено (4xx), коли finish кладе stop-файл, або за стелею часу.

const fs = require('node:fs');
const { paths, oidcToken, call, writeToken, KandoError } = require('./kando');

const INTERVAL_MS = 60e3;
const MAX_MS = 2 * 3600e3;            // job обмежений 90 хв; стеля лише страхує від осиротіння
const FINAL = new Set([403, 404, 409]); // запуск завершено чи токен чужий — далі безглуздо

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

// 'ok' | 'retry' | 'stop'. Текст помилок містить лише статус, не токени.
async function beat({ env, fetchImpl = fetch, sleep, retryMs, log = console }) {
  try {
    const oidc = await oidcToken(env, fetchImpl);
    const res = await call(env.KANDO_URL, `/api/agent/runs/${env.KANDO_RUN_ID}/heartbeat`, {}, { oidc, fetchImpl, sleep, retryMs });
    writeToken(paths(env).token, res.github_token);
    return 'ok';
  } catch (e) {
    if (e instanceof KandoError && FINAL.has(e.status)) {
      log.log(`heartbeat: зупинка, ${e.message}`);
      return 'stop';
    }
    log.log(`heartbeat: збій, повторю на наступному тіку (${e.message})`);
    return 'retry';
  }
}

async function run({ env, fetchImpl = fetch, sleep = sleepMs, intervalMs = INTERVAL_MS, maxMs = MAX_MS, now = Date.now, retryMs, log = console }) {
  const { stop } = paths(env);
  const deadline = now() + maxMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    if (fs.existsSync(stop)) return 'stopped';
    // Повтори всередині call коротші за тік, тож на цьому кроці не затримуємось довго.
    if (await beat({ env, fetchImpl, sleep, retryMs, log }) === 'stop') return 'final';
  }
  return 'expired';
}

if (require.main === module) {
  const env = process.env;
  run({ env, intervalMs: Number(env.KANDO_HEARTBEAT_MS) || INTERVAL_MS })
    .then(r => { console.log(`heartbeat: завершено (${r})`); })
    .catch(e => { console.log(`heartbeat: непередбачений збій (${e.message})`); })
    .finally(() => process.exit(0));
}

module.exports = { beat, run, INTERVAL_MS };
