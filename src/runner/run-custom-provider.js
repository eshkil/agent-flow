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

function buildClaudeArgs({ prompt, pluginDir, model }) {
  const args = [
    '-p', String(prompt || ''),
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
  // Зануляємо токени Anthropic і прибираємо службові змінні ключів інших провайдерів,
  // щоб Claude Code надсилав лише Authorization: Bearer (ANTHROPIC_AUTH_TOKEN).
  out.ANTHROPIC_BASE_URL = resolved.baseUrl;
  out.ANTHROPIC_AUTH_TOKEN = resolved.authToken;
  out.ANTHROPIC_API_KEY = '';
  out.CLAUDE_CODE_OAUTH_TOKEN = '';
  delete out.DEEPSEEK_API_KEY;
  delete out.ZAI_API_KEY;
  delete out.OPENROUTER_API_KEY;

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
    try { writeFailure(env, { stage: 'provider_auth', command: null, exit_code: 1, tail: [msg] }); } catch (_) {}
    throw new Error(msg);
  }
  log.log(`::add-mask::${resolved.authToken}`);

  const bin = String(env.CLAUDE_BIN || '').trim() || 'claude';
  const pluginDir = String(env.KANDO_PLUGIN_DIR || '').trim() || path.resolve(__dirname, '..', '..', 'plugin');
  const args = buildClaudeArgs({ prompt: env.KANDO_PROMPT, pluginDir, model: env.KANDO_MODEL });
  const childEnv = buildChildEnv({ env, resolved });

  const execFile = path.join(paths(env).dir, 'execution.json');
  fs.mkdirSync(paths(env).dir, { recursive: true, mode: 0o700 });

  const tail = tailBuffer();
  const outStream = tail.stream();
  const errStream = tail.stream();
  const stdoutChunks = [];

  const exit = await new Promise((resolve, reject) => {
    const child = spawnImpl(bin, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const rawOut = Buffer.concat(stdoutChunks).toString('utf8');
  const messages = parseStreamJson(rawOut);
  fs.writeFileSync(execFile, JSON.stringify(messages), { mode: 0o600 });
  setOutput('execution_file', execFile);

  if (exit.code !== 0) {
    const exitCode = exit.code ?? (exit.signal ? String(exit.signal) : 1);
    try {
      writeFailure(env, {
        stage: 'provider_run',
        command: `${resolved.provider}:${env.KANDO_MODEL || 'default'}`,
        exit_code: exitCode,
        tail: tail.lines(),
      });
    } catch (_) { /* не заважаємо повернути код виходу */ }
    const e = new Error(`Провайдер ${resolved.provider} завершився з кодом ${exitCode}`);
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
