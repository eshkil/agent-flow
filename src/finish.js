// Крок «після Claude»: завжди знімає agent:running; при збої чи таймауті
// ставить ai:failed на перший номер (той, на який людина дала сигнал).

const { createClient } = require('./github');

async function finish({ env, gh }) {
  const repo = env.GITHUB_REPOSITORY;
  const numbers = (env.LOCK_NUMBERS || '').split(',').map(Number).filter(Boolean);
  if (!numbers.length) return;

  for (const n of numbers) {
    try {
      await gh.rest(`/repos/${repo}/issues/${n}/labels/${encodeURIComponent('agent:running')}`, { method: 'DELETE' });
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }

  const failed = env.ROUTE_OUTCOME === 'failure'
    || ['failure', 'cancelled'].includes(env.CLAUDE_OUTCOME);
  if (!failed) return;

  const [first] = numbers;
  await gh.rest(`/repos/${repo}/issues/${first}/labels`, { method: 'POST', body: { labels: ['ai:failed'] } });
  const why = env.CLAUDE_OUTCOME === 'cancelled' ? 'перевищено час або запуск скасовано' : 'запуск завершився з помилкою';
  await gh.rest(`/repos/${repo}/issues/${first}/comments`, {
    method: 'POST',
    body: { body: `❌ Агент не завершив роботу: ${why}.\nЖурнал: ${env.RUN_URL}\n\nПовторити — постав \`agent:go\` або \`agent:rework\` ще раз.\n\n<sub>🤖 agent-flow</sub>` },
  });
}

if (require.main === module) {
  finish({ env: process.env, gh: createClient({ token: process.env.GH_TOKEN }) })
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { finish };
