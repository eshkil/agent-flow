// Крок «після Claude»: завжди знімає agent:running; при збої чи таймауті
// ставить ai:failed на перший номер (той, на який людина дала сигнал).
// Скіли знімають ai:in-progress наприкінці; якщо він лишився після «успішного»
// Claude — сесія обірвалась без результату (напр. пішла чекати фонових агентів).

const { createClient } = require('./github');
const { DISPATCHER_SIGNATURE } = require('./gather');

const failureBody = (why, runUrl) =>
  `❌ Агент не завершив роботу: ${why}.\nЖурнал: ${runUrl}\n\nПовторити — постав \`agent:go\` або \`agent:rework\` ще раз.\n\n${DISPATCHER_SIGNATURE}`;

async function finish({ env, gh }) {
  const repo = env.GITHUB_REPOSITORY;
  const numbers = (env.LOCK_NUMBERS || '').split(',').map(Number).filter(Boolean);
  if (!numbers.length) {
    // Збій до блокування: лейблів agent:running немає, але сигнал не мусить зникнути мовчки.
    const event = Number(env.EVENT_NUMBER);
    if (env.ROUTE_OUTCOME === 'failure' && event) {
      const errs = [];
      try {
        await gh.rest(`/repos/${repo}/issues/${event}/labels`, { method: 'POST', body: { labels: ['ai:failed'] } });
      } catch (e) { errs.push(e); }
      try {
        await gh.rest(`/repos/${repo}/issues/${event}/comments`, { method: 'POST', body: { body: failureBody('запуск завершився з помилкою', env.RUN_URL) } });
      } catch (e) { errs.push(e); }
      if (errs.length) throw new Error(`finish: ${errs.length} помилка(и): ${errs.map(e => e.message).join('; ')}`);
    }
    return;
  }

  // Збої не перериваємо на першій помилці: кожен крок виконується, а помилки збираються.
  const errors = [];

  for (const n of numbers) {
    try {
      await gh.rest(`/repos/${repo}/issues/${n}/labels/${encodeURIComponent('agent:running')}`, { method: 'DELETE' });
    } catch (e) {
      if (e.status !== 404) errors.push(e);
    }
  }

  // Завислий ai:in-progress знімаємо завжди; 404 — лейбла не було, усе гаразд.
  const stuck = [];
  for (const n of numbers) {
    try {
      await gh.rest(`/repos/${repo}/issues/${n}/labels/${encodeURIComponent('ai:in-progress')}`, { method: 'DELETE' });
      stuck.push(n);
    } catch (e) {
      if (e.status !== 404) errors.push(e);
    }
  }

  const markFailed = async (n, why) => {
    try {
      await gh.rest(`/repos/${repo}/issues/${n}/labels`, { method: 'POST', body: { labels: ['ai:failed'] } });
    } catch (e) {
      errors.push(e);
    }
    try {
      await gh.rest(`/repos/${repo}/issues/${n}/comments`, {
        method: 'POST',
        body: { body: failureBody(why, env.RUN_URL) },
      });
    } catch (e) {
      errors.push(e);
    }
  };

  const failed = env.ROUTE_OUTCOME === 'failure'
    || ['failure', 'cancelled'].includes(env.CLAUDE_OUTCOME);
  if (failed) {
    const why = env.CLAUDE_OUTCOME === 'cancelled' ? 'перевищено час або запуск скасовано' : 'запуск завершився з помилкою';
    await markFailed(numbers[0], why);
  } else {
    for (const n of stuck) {
      await markFailed(n, 'сесія закінчилась без результату (крок не доведено до кінця — лишився `ai:in-progress`)');
    }
  }

  if (errors.length) {
    throw new Error(`finish: ${errors.length} помилка(и): ${errors.map(e => e.message).join('; ')}`);
  }
}

if (require.main === module) {
  finish({ env: process.env, gh: createClient({ token: process.env.GH_TOKEN }) })
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { finish };
