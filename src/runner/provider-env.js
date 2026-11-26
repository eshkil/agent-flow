// Підготовка середовища для Anthropic-сумісних провайдерів (DeepSeek, Z.ai, OpenRouter)
// усередині наявного claude-code-action. Запускається після setup/preflight і до claude,
// тож кроки проєкту не бачать API-ключів провайдера.

const { fileOutput } = require('../output');
const { writeFailure } = require('./failure');

// Білий список провайдерів і їхніх канонічних Anthropic-сумісних ендпоінтів:
// довільний base_url відхиляємо, щоб секрет не міг піти на сторонній хост.
const PROVIDERS = Object.freeze({
  claude: Object.freeze({ baseUrl: '', envKey: null, secretName: null }),
  deepseek: Object.freeze({ baseUrl: 'https://api.deepseek.com/anthropic', envKey: 'DEEPSEEK_API_KEY', secretName: 'DEEPSEEK_API_KEY' }),
  zai: Object.freeze({ baseUrl: 'https://api.z.ai/api/anthropic', envKey: 'ZAI_API_KEY', secretName: 'ZAI_API_KEY' }),
  openrouter: Object.freeze({ baseUrl: 'https://openrouter.ai/api', envKey: 'OPENROUTER_API_KEY', secretName: 'OPENROUTER_API_KEY' }),
});

const trimSlash = url => String(url || '').trim().replace(/\/+$/, '');

function resolveProvider({ provider, baseUrl, env = {} }) {
  const name = String(provider || 'claude').trim().toLowerCase() || 'claude';
  const spec = PROVIDERS[name];
  if (!spec) {
    return { ok: false, stage: 'provider_auth', error: `Невідомий провайдер агента «${name}»` };
  }
  const givenUrl = trimSlash(baseUrl);
  if (name === 'claude') {
    if (givenUrl) {
      return { ok: false, stage: 'provider_auth', error: 'Для провайдера claude сторонній base_url не допускається' };
    }
    return { ok: true, provider: 'claude', isCustom: false, baseUrl: '', authToken: '' };
  }

  const resolvedUrl = givenUrl || spec.baseUrl;
  if (resolvedUrl !== spec.baseUrl) {
    return { ok: false, stage: 'provider_auth', error: `Недозволений base_url для провайдера ${name}: очікується ${spec.baseUrl}` };
  }

  const token = String(env[spec.envKey] || '').trim();
  if (!token) {
    return {
      ok: false,
      stage: 'provider_auth',
      error: `Для провайдера ${name} у репозиторії не задано секрет ${spec.secretName}`,
    };
  }
  return { ok: true, provider: name, isCustom: true, baseUrl: resolvedUrl, authToken: token };
}

function applyProviderEnv({ env, setOutput = () => {}, setEnv = () => {}, log = console }) {
  const res = resolveProvider({ provider: env.KANDO_PROVIDER, baseUrl: env.KANDO_BASE_URL, env });
  if (!res.ok) {
    writeFailure(env, { stage: res.stage, command: null, exit_code: 1, tail: [res.error] });
    throw new Error(res.error);
  }
  setOutput('provider', res.provider);
  setOutput('is_custom', res.isCustom ? 'true' : 'false');
  setOutput('base_url', res.baseUrl);
  if (res.isCustom) {
    // Маскуємо до запису в GITHUB_ENV і зануляємо ANTHROPIC_API_KEY, щоб Claude Code
    // не надсилав конфліктний X-Api-Key на сторонній ендпоінт.
    log.log(`::add-mask::${res.authToken}`);
    setEnv('ANTHROPIC_BASE_URL', res.baseUrl);
    setEnv('ANTHROPIC_AUTH_TOKEN', res.authToken);
    setEnv('ANTHROPIC_API_KEY', '');
    log.log(`Kando: провайдер ${res.provider} (${res.baseUrl})`);
  }
  return res;
}

if (require.main === module) {
  try {
    applyProviderEnv({
      env: process.env,
      setOutput: fileOutput(process.env.GITHUB_OUTPUT),
      setEnv: fileOutput(process.env.GITHUB_ENV),
    });
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}

module.exports = { PROVIDERS, resolveProvider, applyProviderEnv };
