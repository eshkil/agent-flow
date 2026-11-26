// Валідація провайдера й наявності ключа для Anthropic-сумісних провайдерів
// (DeepSeek, Z.ai, OpenRouter). Секрет у GITHUB_ENV чи GITHUB_OUTPUT не пишеться:
// його безпосередньо читає крок run-custom-provider.js (ізольовано від setup/files).

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
  if (!Object.hasOwn(PROVIDERS, name)) {
    return { ok: false, stage: 'provider_auth', error: `Невідомий провайдер агента «${name}»` };
  }
  const spec = PROVIDERS[name];
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

function recordFailure(env, report) {
  try { writeFailure(env, report); } catch (_) { /* не заважаємо завершити крок */ }
}

function checkProvider({ env, setOutput = () => {}, log = console }) {
  const res = resolveProvider({ provider: env.KANDO_PROVIDER, baseUrl: env.KANDO_BASE_URL, env });
  if (!res.ok) {
    recordFailure(env, { stage: res.stage, command: null, exit_code: 1, tail: [res.error] });
    throw new Error(res.error);
  }
  setOutput('provider', res.provider);
  setOutput('is_custom', res.isCustom ? 'true' : 'false');
  setOutput('base_url', res.baseUrl);
  if (res.isCustom) {
    log.log(`::add-mask::${res.authToken}`);
    log.log(`Kando: провайдер ${res.provider} (${res.baseUrl})`);
  }
  return res;
}

if (require.main === module) {
  try {
    checkProvider({
      env: process.env,
      setOutput: fileOutput(process.env.GITHUB_OUTPUT),
    });
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}

module.exports = { PROVIDERS, resolveProvider, checkProvider };
