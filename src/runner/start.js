// Крок start: міняє OIDC-токен Actions на токен GitHub і промпт від Kando.
// Токен лягає у файл (0600), а не у вихід кроку: його оновлює heartbeat,
// а bin/gh і git-credential-kando читають актуальний.

const fs = require('node:fs');
const path = require('node:path');
const { fileOutput } = require('../output');
const { paths, oidcToken, call, writeToken, gitConfigEnv } = require('./kando');

const BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');

async function start({ env, fetchImpl = fetch, setOutput = () => {}, setEnv = () => {}, addPath = () => {}, binDir = BIN_DIR, sleep, retryMs, log = console }) {
  const oidc = await oidcToken(env, fetchImpl);
  const res = await call(env.KANDO_URL, `/api/agent/runs/${env.KANDO_RUN_ID}/start`, {}, { oidc, fetchImpl, sleep, retryMs });
  // Маскуємо до будь-якого іншого виводу: токен не має потрапити в журнал.
  log.log(`::add-mask::${res.github_token}`);
  writeToken(paths(env).token, res.github_token);
  fs.rmSync(paths(env).stop, { force: true });

  // Обгортка gh перекриває справжній gh для наступних кроків; git-конфіг — лише на job.
  addPath(binDir);
  const git = gitConfigEnv({ env, helper: path.join(binDir, 'git-credential-kando'), startToken: res.github_token });
  for (const [k, v] of Object.entries(git)) setEnv(k, v);

  // Токен старту — у вихід (замаскований), а не з файлу: heartbeat уже міг оновити файл,
  // а claude-code-action вшиє саме цей токен в origin, і insteadOf мусить збігтись із ним.
  setOutput('github_token', res.github_token);
  setOutput('prompt', res.prompt);
  setOutput('model', res.model || '');
  setOutput('skill', res.skill || '');
  setOutput('mode', res.mode || '');
  setOutput('bot_login', res.bot?.login || '');
  setOutput('bot_id', res.bot?.id ?? '');
  setOutput('issue', res.issue ?? '');
  setOutput('pr', res.pr ?? '');
  log.log(`Kando: запуск ${env.KANDO_RUN_ID}, скіл ${res.skill}/${res.mode}, токен до ${res.expires_at}`);
  return res;
}

if (require.main === module) {
  const addPath = dir => fs.appendFileSync(process.env.GITHUB_PATH, `${dir}\n`);
  start({ env: process.env, setOutput: fileOutput(process.env.GITHUB_OUTPUT), setEnv: fileOutput(process.env.GITHUB_ENV), addPath }).catch(e => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}

module.exports = { start };
