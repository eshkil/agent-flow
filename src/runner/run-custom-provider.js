// Запуск Claude Code CLI напряму для Anthropic-сумісних провайдерів
// (DeepSeek, Z.ai, OpenRouter). Оминає validate-env.ts у claude-code-action,
// який вимагає ANTHROPIC_API_KEY або CLAUDE_CODE_OAUTH_TOKEN і не приймає
// ANTHROPIC_AUTH_TOKEN. Водночас використовує той самий бінарник Claude Code,
// --plugin-dir із 7 скілами і пише execution_file у форматі масиву SDK-повідомлень.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fileOutput } = require('../output');
const { paths } = require('./kando');
const { writeFailure, tailBuffer } = require('./failure');
const { resolveProvider } = require('./provider-env');

const ALLOWED_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,TodoWrite,Skill';
const DISALLOWED_TOOLS = 'ScheduleWakeup,CronCreate,Monitor,RemoteTrigger';

// Промпт передається через stdin (а не позиційним аргументом після `-p`), щоб
// провідний `-` не сприймався як прапорець CLI і не бився в ліміт MAX_ARG_STRLEN.
function buildClaudeArgs({ pluginDir, model }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--plugin-dir', pluginDir,
    '--allowedTools', ALLOWED_TOOLS,
    '--disallowedTools', DISALLOWED_TOOLS,
  ];
  const m = String(model || '').trim();
  if (m) args.push('--model', m);
  return args;
}

function buildChildEnv({ env, resolved }) {
  const out = { ...env };
  // Зануляємо токени Anthropic, прибираємо ключі інших провайдерів і OIDC-змінні
  // GitHub Actions (щоб інструменти агента не могли випустити JWT для audience=kando-agent).
  out.ANTHROPIC_BASE_URL = resolved.baseUrl;
  out.ANTHROPIC_AUTH_TOKEN = resolved.authToken;
  out.ANTHROPIC_API_KEY = '';
  out.CLAUDE_CODE_OAUTH_TOKEN = '';
  delete out.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete out.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete out.DEEPSEEK_API_KEY;
  delete out.ZAI_API_KEY;
  delete out.OPENROUTER_API_KEY;
  delete out.KANDO_PROMPT;

  const botLogin = String(env.KANDO_BOT_LOGIN || '').trim();
  const botId = String(env.KANDO_BOT_ID || '').trim();
  if (botLogin) {
    const email = botId ? `${botId}+${botLogin}@users.noreply.github.com` : `${botLogin}@users.noreply.github.com`;
    out.GIT_AUTHOR_NAME = botLogin;
    out.GIT_COMMITTER_NAME = botLogin;
    out.GIT_AUTHOR_EMAIL = email;
    out.GIT_COMMITTER_EMAIL = email;
  }
  return out;
}

// Збирає NDJSON-вивід `--output-format stream-json` у масив повідомлень (як execution_file
// claude-code-action), щоб finish.js / limit.js читали його однаково для всіх провайдерів.
function parseStreamJson(raw) {
  const messages = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') messages.push(obj);
    } catch { /* не-JSON рядок (діагностика) пропускаємо в масиві SDK */ }
  }
  return messages;
}

function recordFailure(env, report) {
  try { writeFailure(env, report); } catch (_) { /* не заважаємо повернути помилку */ }
}

async function runCustomProvider({
  env,
  spawnImpl = spawn,
  setOutput = () => {},
  out = process.stdout,
  err = process.stderr,
  log = console,
}) {
  const resolved = resolveProvider({ provider: env.KANDO_PROVIDER, baseUrl: env.KANDO_BASE_URL, env });
  if (!resolved.ok || !resolved.isCustom) {
    const msg = resolved.ok ? 'run-custom-provider викликано для claude' : resolved.error;
    recordFailure(env, { stage: 'provider_auth', command: null, exit_code: 1, tail: [msg] });
    throw new Error(msg);
  }
  log.log(`::add-mask::${resolved.authToken}`);

  const bin = String(env.CLAUDE_BIN || '').trim() || 'claude';
  const pluginDir = String(env.KANDO_PLUGIN_DIR || '').trim() || path.resolve(__dirname, '..', '..', 'plugin');
  const args = buildClaudeArgs({ pluginDir, model: env.KANDO_MODEL });
  const childEnv = buildChildEnv({ env, resolved });
  const commandLabel = `${resolved.provider}:${env.KANDO_MODEL || 'default'}`;

  const execFile = path.join(paths(env).dir, 'execution.json');
  fs.mkdirSync(paths(env).dir, { recursive: true, mode: 0o700 });

  const tail = tailBuffer();
  const outStream = tail.stream();
  const errStream = tail.stream();
  const stdoutChunks = [];

  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      const child = spawnImpl(bin, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin?.on('error', () => {});
      child.stdin?.end(String(env.KANDO_PROMPT || ''));
      child.stdout?.on('data', chunk => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        outStream.push(chunk);
        out.write(chunk);
      });
      child.stderr?.on('data', chunk => {
        errStream.push(chunk);
        err.write(chunk);
      });
      child.on('error', reject);
      // Слухаємо саме `close`, а не `exit`, щоб дочекатись повного зливу stdout/stderr.
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
  } catch (spawnErr) {
    recordFailure(env, {
      stage: 'provider_run',
      command: commandLabel,
      exit_code: spawnErr.code || 1,
      tail: [spawnErr.message],
    });
    throw spawnErr;
  }

  const rawOut = Buffer.concat(stdoutChunks).toString('utf8');
  const messages = parseStreamJson(rawOut);
  fs.writeFileSync(execFile, JSON.stringify(messages), { mode: 0o600 });
  setOutput('execution_file', execFile);

  const resultMsg = messages.findLast(m => m?.type === 'result');
  const resultError = !resultMsg || Boolean(resultMsg.is_error);

  if (exit.code !== 0 || resultError) {
    const exitCode = exit.code !== 0 ? (exit.code ?? (exit.signal ? String(exit.signal) : 1)) : 1;
    const lines = tail.lines();
    if (!lines.length && resultMsg?.result) lines.push(String(resultMsg.result));
    if (!lines.length && !resultMsg) lines.push('Сесія завершилась без фінального результату SDK');
    recordFailure(env, {
      stage: 'provider_run',
      command: commandLabel,
      exit_code: exitCode,
      tail: lines,
    });
    const reason = exit.code !== 0
      ? `Провайдер ${resolved.provider} завершився з кодом ${exitCode}`
      : `Провайдер ${resolved.provider} повернув помилку сесії`;
    const e = new Error(reason);
    e.exitCode = exitCode;
    throw e;
  }
  return { executionFile: execFile, messages };
}

if (require.main === module) {
  runCustomProvider({
    env: process.env,
    setOutput: fileOutput(process.env.GITHUB_OUTPUT),
  }).catch(e => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}

module.exports = { buildClaudeArgs, buildChildEnv, parseStreamJson, runCustomProvider };
