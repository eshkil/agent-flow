const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROVIDERS, resolveProvider, applyProviderEnv } = require('../src/runner/provider-env');
const { failurePath } = require('../src/runner/failure');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kando-provider-'));
const silent = { log: () => {} };

test('resolveProvider: claude за замовчуванням (порожньо / undefined / claude) → не custom', () => {
  for (const provider of [undefined, '', '  ', 'claude', 'CLAUDE']) {
    const r = resolveProvider({ provider, baseUrl: '', env: {} });
    assert.deepEqual(r, { ok: true, provider: 'claude', isCustom: false, baseUrl: '', authToken: '' });
  }
});

test('resolveProvider: claude із стороннім base_url відхиляється', () => {
  const r = resolveProvider({ provider: 'claude', baseUrl: 'https://evil.example/api', env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'provider_auth');
  assert.match(r.error, /base_url/);
});

test('resolveProvider: deepseek / zai / openrouter з ключем → канонічний base_url і токен', () => {
  const cases = [
    ['deepseek', 'DEEPSEEK_API_KEY', 'sk-ds-123456', 'https://api.deepseek.com/anthropic'],
    ['zai', 'ZAI_API_KEY', 'id123.secret456', 'https://api.z.ai/api/anthropic'],
    ['openrouter', 'OPENROUTER_API_KEY', 'sk-or-v1-abcdef', 'https://openrouter.ai/api'],
  ];
  for (const [provider, envKey, keyVal, expectedUrl] of cases) {
    // Порожній baseUrl бере канонічний з allowlist; хвостовий слеш нормалізується.
    for (const baseUrl of ['', expectedUrl, `${expectedUrl}/`]) {
      const r = resolveProvider({ provider, baseUrl, env: { [envKey]: ` ${keyVal} ` } });
      assert.deepEqual(r, { ok: true, provider, isCustom: true, baseUrl: expectedUrl, authToken: keyVal });
    }
  }
});

test('resolveProvider: відсутній секрет стороннього провайдера → зрозуміла помилка без витоку', () => {
  for (const [provider, secretName] of [['deepseek', 'DEEPSEEK_API_KEY'], ['zai', 'ZAI_API_KEY'], ['openrouter', 'OPENROUTER_API_KEY']]) {
    const r = resolveProvider({ provider, baseUrl: PROVIDERS[provider].baseUrl, env: {} });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'provider_auth');
    assert.ok(r.error.includes(secretName), r.error);
  }
});

test('resolveProvider: невідомий провайдер або недозволений base_url → відмова', () => {
  const badProv = resolveProvider({ provider: 'gemini', baseUrl: '', env: {} });
  assert.equal(badProv.ok, false);
  assert.match(badProv.error, /gemini/);

  const badUrl = resolveProvider({
    provider: 'deepseek',
    baseUrl: 'https://evil.example/anthropic',
    env: { DEEPSEEK_API_KEY: 'sk-1234567890' },
  });
  assert.equal(badUrl.ok, false);
  assert.equal(badUrl.stage, 'provider_auth');
  assert.match(badUrl.error, /base_url/);
  assert.ok(!badUrl.error.includes('sk-1234567890'));
});

test('applyProviderEnv: сторонній провайдер ставить ANTHROPIC_BASE_URL/AUTH_TOKEN, зануляє API_KEY і маскує токен', () => {
  const env = {
    RUNNER_TEMP: tmp(),
    KANDO_PROVIDER: 'deepseek',
    KANDO_BASE_URL: 'https://api.deepseek.com/anthropic',
    DEEPSEEK_API_KEY: 'sk-secret-deepseek-key',
  };
  const out = {}, envSet = {}, lines = [];
  applyProviderEnv({
    env,
    setOutput: (k, v) => { out[k] = v; },
    setEnv: (k, v) => { envSet[k] = v; },
    log: { log: l => lines.push(l) },
  });

  assert.deepEqual(out, {
    provider: 'deepseek',
    is_custom: 'true',
    base_url: 'https://api.deepseek.com/anthropic',
  });
  assert.deepEqual(envSet, {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-secret-deepseek-key',
    ANTHROPIC_API_KEY: '',
  });
  assert.equal(lines[0], '::add-mask::sk-secret-deepseek-key');
  assert.ok(!lines.slice(1).some(l => l.includes('sk-secret-deepseek-key')));
  assert.ok(!fs.existsSync(failurePath(env)));
});

test('applyProviderEnv: claude не змінює GITHUB_ENV і не пише failure.json', () => {
  const env = { RUNNER_TEMP: tmp(), KANDO_PROVIDER: 'claude', KANDO_BASE_URL: '' };
  const out = {}, envSet = {};
  applyProviderEnv({ env, setOutput: (k, v) => { out[k] = v; }, setEnv: (k, v) => { envSet[k] = v; }, log: silent });
  assert.deepEqual(out, { provider: 'claude', is_custom: 'false', base_url: '' });
  assert.deepEqual(envSet, {});
  assert.ok(!fs.existsSync(failurePath(env)));
});

test('applyProviderEnv: відсутній ключ → кидає помилку і пише failure.json (stage: provider_auth)', () => {
  const env = { RUNNER_TEMP: tmp(), RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', KANDO_PROVIDER: 'zai', KANDO_BASE_URL: '' };
  assert.throws(() => applyProviderEnv({ env, log: silent }), /ZAI_API_KEY/);
  const saved = JSON.parse(fs.readFileSync(failurePath(env), 'utf8'));
  assert.equal(saved.stage, 'provider_auth');
  assert.equal(saved.exit_code, 1);
  assert.ok(saved.tail.some(l => l.includes('ZAI_API_KEY')));
});

test('action.yml: крок provider іде після setup і перед claude; setup не бачить ключів провайдерів', () => {
  const actionYml = fs.readFileSync(path.join(__dirname, '..', 'runner', 'action.yml'), 'utf8');
  const at = id => actionYml.indexOf(`- id: ${id}\n`);
  assert.ok(at('setup') < at('provider') && at('provider') < at('claude'));
  const step = id => actionYml.split(/\n    - id: /).find(b => b.startsWith(`${id}\n`));
  for (const key of ['deepseek_api_key', 'zai_api_key', 'openrouter_api_key']) {
    assert.ok(!step('setup').includes(key), `setup не має бачити ${key}`);
    assert.ok(!step('files').includes(key), `files не має бачити ${key}`);
    assert.ok(step('provider').includes(key), `provider має отримувати ${key}`);
  }
  assert.ok(step('claude').includes("steps.provider.outputs.is_custom == 'true' && '' || inputs.claude_code_oauth_token"));
  assert.ok(step('claude').includes("steps.provider.outputs.is_custom == 'true' && '' || inputs.anthropic_api_key"));
});
