// Крок «до Claude»: дозвіл, блокування, маршрутизація, коментарі-відмови, промпт.
// Виходи кроку читає action.yml. lock_numbers пишемо ДО блокування: якщо збій
// станеться посеред циклу (наприклад, POST на другому номері), finish.js уже знає
// номери і зніме agent:running; DELETE там ковтає 404 для номерів без лейбла.

const fs = require('node:fs');
const { createClient } = require('./github');
const { gather, DISPATCHER_SIGNATURE } = require('./gather');
const { route } = require('./route');
const { buildPrompt } = require('./prompt');
const { pickModel } = require('./model');
const { fileOutput } = require('./output');

const PR_ISSUES = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { closingIssuesReferences(first: 5) { nodes { number } } }
  }
}`;

async function removeLabel(gh, repo, number, name) {
  try {
    await gh.rest(`/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, { method: 'DELETE' });
  } catch (e) {
    if (e.status !== 404) throw e; // лейбла вже немає — мета досягнута
  }
}

const comment = (gh, repo, number, body) =>
  gh.rest(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body: `${body}\n\n${DISPATCHER_SIGNATURE}` } });

async function labelsOf(gh, repo, number) {
  const it = await gh.rest(`/repos/${repo}/issues/${number}`);
  return (it.labels || []).map(l => l.name);
}

async function run({ event, env, gh, setOutput }) {
  const repo = env.GITHUB_REPOSITORY;
  const [owner, name] = repo.split('/');
  const triggerLabel = event.label.name;
  const trigger = triggerLabel === 'agent:go' ? 'go' : 'rework';
  const kind = event.pull_request ? 'pr' : 'issue';
  const number = (event.pull_request || event.issue).number;
  const sender = event.sender.login;
  const allowedUsers = (env.AGENT_ALLOWED_USERS || event.repository.owner.login)
    .split(',').map(s => s.trim()).filter(Boolean);
  const stop = () => setOutput('action', 'stop');

  // Номер сигналу — ДО першого запиту: якщо збій станеться до блокування,
  // finish.js усе одно знає, де лишити ai:failed.
  setOutput('event_number', String(number));

  await removeLabel(gh, repo, number, triggerLabel);

  if (!allowedUsers.includes(sender)) {
    await comment(gh, repo, number, `@${sender}, немає дозволу запускати агента в цьому репозиторії.`);
    return stop();
  }

  const state = await gather({
    repo, kind, number, agentLogin: env.AGENT_LOGIN, allowedUsers, ownRunId: env.GITHUB_RUN_ID,
  }, gh);

  // Задача — це issue і його PR разом: блокування перевіряємо й ставимо на обох.
  let linkedIssue = null;
  if (kind === 'pr') {
    const d = await gh.graphql(PR_ISSUES, { owner, name, number });
    linkedIssue = d.repository.pullRequest.closingIssuesReferences.nodes[0]?.number ?? null;
  }
  // Змерджений PR уже не змінюється — блокувати його нема сенсу.
  const lockPr = state.pr?.state === 'merged' ? null : state.pr?.number;
  const lockNumbers = [...new Set([number, lockPr, linkedIssue].filter(Boolean))];
  const running = state.labels.includes('agent:running')
    || state.pr?.labels.includes('agent:running')
    || (linkedIssue && (await labelsOf(gh, repo, linkedIssue)).includes('agent:running'));
  if (running) {
    await comment(gh, repo, number, 'Агент уже працює над цією задачею — дочекайся результату. Якщо запуск завис (у журналі Actions немає активного запуску) — зніми лейбл `agent:running` вручну й постав сигнал знову.');
    return stop();
  }

  const decision = route(state, trigger, { allowedUsers });
  if (decision.action === 'refuse') {
    await comment(gh, repo, number, decision.reason);
    return stop();
  }
  let model;
  try {
    model = pickModel(env.AGENT_MODEL, decision.skill);
  } catch (e) {
    await comment(gh, repo, number, `Помилка в змінній \`AGENT_MODEL\`: ${e.message}. Виправ її в налаштуваннях репозиторію й постав сигнал знову.`);
    return stop();
  }
  if (env.AGENT_DRY_RUN === '1') {
    const modelText = model ? `модель \`${model}\`` : 'модель за замовчуванням';
    await comment(gh, repo, number, `Dry run: запустив би \`${decision.skill}\` у режимі \`${decision.mode}\` (етап \`${decision.stage}\`), ${modelText}.`);
    return stop();
  }

  setOutput('lock_numbers', lockNumbers.join(','));
  for (const n of lockNumbers) {
    for (const l of ['ai:failed', 'ai:limit', 'needs-human', 'ai:in-progress']) await removeLabel(gh, repo, n, l);
    await gh.rest(`/repos/${repo}/issues/${n}/labels`, { method: 'POST', body: { labels: ['agent:running'] } });
  }

  setOutput('skill', decision.skill);
  setOutput('mode', decision.mode);
  setOutput('model', model);
  setOutput('prompt', buildPrompt({
    repo, decision, sender, trigger,
    signalAt: (event.pull_request || event.issue).updated_at,
    runUrl: env.RUN_URL,
  }));
  setOutput('action', 'run');
}

if (require.main === module) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const gh = createClient({ token: process.env.GH_TOKEN });
  run({ event, env: process.env, gh, setOutput: fileOutput(process.env.GITHUB_OUTPUT) })
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run };
