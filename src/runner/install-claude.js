// Крок claude-install: своя копія Claude Code для цього запуску.
//
// claude-code-action ставить Claude Code у $HOME/.claude/downloads/claude-<версія>-<платформа>.
// Кілька runner-ів на одному сервері ділять $HOME, тож запуски, що стартували разом, перезаписують
// цей файл один одному: «Checksum verification failed» і «Text file busy», усі спроби марні. Тому
// ставимо ту саму версію в окрему теку всередині RUNNER_TEMP і передаємо дії готовий шлях. Сам агент
// працює зі справжнім $HOME: там кеші й налаштування машини.
//
// Будь-який збій тут не зупиняє запуск: без шляху дія поставить Claude Code сама, як раніше.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ATTEMPTS = 2;
const TIMEOUT_MS = 5 * 60e3;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$/;

// Версію визначає дія (`v1` рухається), тож беремо її з коду самої дії поруч із цим action.
function pinnedVersion(actionPath) {
  // actionPath: <_actions>/eshkil/agent-flow/<версія>/runner
  const file = path.join(actionPath, '..', '..', '..', '..', 'anthropics', 'claude-code-action', 'v1', 'src', 'entrypoints', 'run.ts');
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const m = src.match(/claudeCodeVersion\s*=\s*"([^"]+)"/);
  return m && VERSION.test(m[1]) ? m[1] : null;
}

function installClaude({ version, runnerTemp, spawn = spawnSync, log = console }) {
  const home = path.join(runnerTemp, 'kando-claude-home');
  const exe = path.join(home, '.local', 'bin', 'claude');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home };
  const command = `set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s -- ${version}`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    log.log(`Claude Code ${version}: окрема копія для запуску, спроба ${attempt}`);
    const r = spawn('bash', ['-c', command], { stdio: 'inherit', env, timeout: TIMEOUT_MS });
    if (r.status === 0 && fs.existsSync(exe)) return exe;
  }
  return null;
}

function main({ env = process.env, log = console, install = installClaude } = {}) {
  const version = pinnedVersion(env.GITHUB_ACTION_PATH || '');
  if (!version) {
    log.log('::warning::Не вдалося визначити версію Claude Code: її поставить claude-code-action');
    return;
  }
  let exe = null;
  try { exe = install({ version, runnerTemp: env.RUNNER_TEMP, log }); } catch (e) { log.log(`::warning::${e.message}`); }
  if (!exe) {
    log.log('::warning::Окрему копію Claude Code не встановлено: її поставить claude-code-action');
    return;
  }
  fs.appendFileSync(env.GITHUB_OUTPUT, `path=${exe}\n`);
}

if (require.main === module) main();

module.exports = { pinnedVersion, installClaude, main };
