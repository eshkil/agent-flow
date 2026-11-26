const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROVIDERS, resolveProvider, checkProvider } = require('../src/runner/provider-env');
const { buildClaudeArgs, buildChildEnv, parseStreamJson, runCustomProvider } = require('../src/runner/run-custom-provider');
const { failurePath } = require('../src/runner/failure');
const { secretsFrom } = require('../src/runner/mask');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kando-provider-'));
const silent = { log: () => {} };

function makeFakeChild() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.stdinData = '';
  p.stdin = new EventEmitter();
  p.stdin.end = chunk => { if (chunk) p.stdinData += String(chunk); };
  return p;
}

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

test('resolveProvider: невідомий провайдер (зокрема ключі Object.prototype) або чужий base_url → відмова', () => {
  for (const name of ['gemini', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = resolveProvider({ provider: name, baseUrl: '', env: {} });
    assert.equal(r.ok, false, name);
    assert.equal(r.stage, 'provider_auth', name);
    assert.match(r.error, /Невідомий провайдер/, name);
  }

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

test('checkProvider: сторонній провайдер ставить лише outputs (без секрету в outputs/env) і маскує токен', () => {
  const env = {
    RUNNER_TEMP: tmp(),
    KANDO_PROVIDER: 'deepseek',
    KANDO_BASE_URL: 'https://api.deepseek.com/anthropic',
    DEEPSEEK_API_KEY: 'sk-secret-deepseek-key',
  };
  const out = {}, lines = [];
  checkProvider({ env, setOutput: (k, v) => { out[k] = v; }, log: { log: l => lines.push(l) } });
  assert.deepEqual(out, {
    provider: 'deepseek',
    is_custom: 'true',
    base_url: 'https://api.deepseek.com/anthropic',
  });
  assert.ok(!Object.values(out).some(v => String(v).includes('sk-secret-deepseek-key')));
  assert.equal(lines[0], '::add-mask::sk-secret-deepseek-key');
  assert.ok(!lines.slice(1).some(l => l.includes('sk-secret-deepseek-key')));
  assert.ok(!fs.existsSync(failurePath(env)));
});

test('checkProvider: відсутній ключ → помилка і failure.json (stage: provider_auth); збій запису failure не підміняє помилку', () => {
  const env = { RUNNER_TEMP: tmp(), RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', KANDO_PROVIDER: 'zai', KANDO_BASE_URL: '' };
  assert.throws(() => checkProvider({ env, log: silent }), /ZAI_API_KEY/);
  const saved = JSON.parse(fs.readFileSync(failurePath(env), 'utf8'));
  assert.equal(saved.stage, 'provider_auth');
  assert.equal(saved.exit_code, 1);
  assert.ok(saved.tail.some(l => l.includes('ZAI_API_KEY')));

  const fileAsDir = path.join(tmp(), 'not-a-dir');
  fs.writeFileSync(fileAsDir, 'x');
  assert.throws(() => checkProvider({ env: { ...env, RUNNER_TEMP: fileAsDir }, log: silent }), /ZAI_API_KEY/);
});

test('runCustomProvider: передає промпт через stdin, прибирає OIDC/чужі ключі з env, чекає close і пише execution.json', async () => {
  const dir = tmp();
  const env = {
    RUNNER_TEMP: dir,
    CLAUDE_BIN: '/opt/claude/bin/claude',
    KANDO_PLUGIN_DIR: '/opt/af/plugin',
    KANDO_PROVIDER: 'deepseek',
    KANDO_BASE_URL: 'https://api.deepseek.com/anthropic',
    KANDO_MODEL: 'deepseek-v4-pro',
    KANDO_PROMPT: '--leading-dash Виконай triage',
    KANDO_BOT_LOGIN: 'kando[bot]',
    KANDO_BOT_ID: '77',
    DEEPSEEK_API_KEY: 'sk-ds-secret',
    ZAI_API_KEY: 'other-secret',
    ANTHROPIC_API_KEY: 'sk-ant-should-clear',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-should-clear',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.test/oidc',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-req-secret',
  };
  let seen, childRef;
  const spawnImpl = (bin, args, opts) => {
    const p = makeFakeChild();
    seen = { bin, args, opts };
    childRef = p;
    setImmediate(() => {
      // Емітуємо exit раніше за останній чанк stdout і close (як буває в Node.js).
      p.stdout.emit('data', '{"type":"assistant","message":"ok"}\n');
      p.emit('exit', 0, null);
      setImmediate(() => {
        p.stdout.emit('data', '{"type":"result","is_error":false,"result":"done"}\n');
        p.emit('close', 0, null);
      });
    });
    return p;
  };
  const out = {};
  const sink = { write: () => true };
  const res = await runCustomProvider({ env, spawnImpl, setOutput: (k, v) => { out[k] = v; }, out: sink, err: sink, log: silent });

  assert.equal(seen.bin, '/opt/claude/bin/claude');
  assert.ok(seen.args.includes('--plugin-dir') && seen.args.includes('/opt/af/plugin'));
  assert.ok(seen.args.includes('--model') && seen.args.includes('deepseek-v4-pro'));
  assert.ok(!seen.args.includes('--leading-dash Виконай triage'), 'промпт іде через stdin, не аргументом CLI');
  assert.equal(childRef.stdinData, '--leading-dash Виконай triage');

  assert.equal(seen.opts.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(seen.opts.env.ANTHROPIC_AUTH_TOKEN, 'sk-ds-secret');
  assert.equal(seen.opts.env.ANTHROPIC_API_KEY, '');
  assert.equal(seen.opts.env.CLAUDE_CODE_OAUTH_TOKEN, '');
  assert.equal(seen.opts.env.ACTIONS_ID_TOKEN_REQUEST_URL, undefined);
  assert.equal(seen.opts.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(seen.opts.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(seen.opts.env.ZAI_API_KEY, undefined);
  assert.equal(seen.opts.env.KANDO_PROMPT, undefined);
  assert.equal(seen.opts.env.GIT_AUTHOR_NAME, 'kando[bot]');
  assert.equal(seen.opts.env.GIT_AUTHOR_EMAIL, '77+kando[bot]@users.noreply.github.com');

  assert.equal(out.execution_file, res.executionFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(res.executionFile, 'utf8')), [
    { type: 'assistant', message: 'ok' },
    { type: 'result', is_error: false, result: 'done' },
  ]);
  assert.ok(!fs.existsSync(failurePath(env)));
});

test('runCustomProvider: exit 0 із result.is_error=true або без result → помилка, execution.json і failure.json', async () => {
  for (const [label, payload] of [
    ['is_error=true', '{"type":"result","is_error":true,"result":"429 Too Many Requests"}\n'],
    ['no result', '{"type":"assistant","message":"cut off"}\n'],
  ]) {
    const dir = tmp();
    const env = {
      RUNNER_TEMP: dir,
      KANDO_PROVIDER: 'openrouter',
      KANDO_MODEL: 'minimax/minimax-m3',
      KANDO_PROMPT: 'hi',
      OPENROUTER_API_KEY: 'sk-or-v1-abc',
    };
    const spawnImpl = () => {
      const p = makeFakeChild();
      setImmediate(() => {
        p.stdout.emit('data', payload);
        p.emit('close', 0, null);
      });
      return p;
    };
    const out = {};
    const sink = { write: () => true };
    await assert.rejects(
      runCustomProvider({ env, spawnImpl, setOutput: (k, v) => { out[k] = v; }, out: sink, err: sink, log: silent }),
      /помилку сесії/,
      label
    );
    assert.ok(fs.existsSync(out.execution_file), label);
    const saved = JSON.parse(fs.readFileSync(failurePath(env), 'utf8'));
    assert.equal(saved.stage, 'provider_run', label);
  }
});

test('runCustomProvider: помилка spawn (ENOENT) пише failure.json (stage: provider_run)', async () => {
  const dir = tmp();
  const env = {
    RUNNER_TEMP: dir,
    CLAUDE_BIN: '/nonexistent/claude',
    KANDO_PROVIDER: 'deepseek',
    KANDO_MODEL: 'deepseek-v4-pro',
    KANDO_PROMPT: 'hi',
    DEEPSEEK_API_KEY: 'sk-ds-123',
  };
  const spawnImpl = () => {
    const p = makeFakeChild();
    setImmediate(() => {
      const err = new Error('spawn /nonexistent/claude ENOENT');
      err.code = 'ENOENT';
      p.emit('error', err);
    });
    return p;
  };
  const sink = { write: () => true };
  await assert.rejects(runCustomProvider({ env, spawnImpl, out: sink, err: sink, log: silent }), /ENOENT/);
  const saved = JSON.parse(fs.readFileSync(failurePath(env), 'utf8'));
  assert.equal(saved.stage, 'provider_run');
  assert.equal(saved.exit_code, 'ENOENT');
  assert.ok(saved.tail.some(l => l.includes('ENOENT')));
});

test('buildClaudeArgs, buildChildEnv, parseStreamJson і mask.secretsFrom', () => {
  assert.ok(!buildClaudeArgs({ pluginDir: '/p', model: '' }).includes('--model'));
  assert.deepEqual(parseStreamJson('not-json\n{"a":1}\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  const ce = buildChildEnv({
    env: { ANTHROPIC_API_KEY: 'x', ACTIONS_ID_TOKEN_REQUEST_URL: 'u', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' },
    resolved: { baseUrl: 'https://a', authToken: 'tok' },
  });
  assert.equal(ce.ANTHROPIC_API_KEY, '');
  assert.equal(ce.ACTIONS_ID_TOKEN_REQUEST_URL, undefined);
  assert.equal(ce.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  const secrets = secretsFrom({
    RUNNER_TEMP: tmp(),
    KANDO_MASK_DEEPSEEK_KEY: 'ds-key',
    KANDO_MASK_ZAI_KEY: 'zai-key',
    KANDO_MASK_OPENROUTER_KEY: 'or-key',
  });
  assert.ok(secrets.includes('ds-key') && secrets.includes('zai-key') && secrets.includes('or-key'));
});

test('action.yml: claude і claude_custom взаємно виключні, setup/files не бачать ключів, finish читає відповідний outcome і execution_file', () => {
  const actionYml = fs.readFileSync(path.join(__dirname, '..', 'runner', 'action.yml'), 'utf8');
  const at = id => actionYml.indexOf(`- id: ${id}\n`);
  assert.ok(at('setup') < at('provider') && at('provider') < at('claude') && at('claude') < at('claude_custom'));
  const step = id => actionYml.split(/\n    - id: /).find(b => b.startsWith(`${id}\n`));
  for (const key of ['deepseek_api_key', 'zai_api_key', 'openrouter_api_key']) {
    assert.ok(!step('setup').includes(key), `setup не має бачити ${key}`);
    assert.ok(!step('files').includes(key), `files не має бачити ${key}`);
    assert.ok(step('provider').includes(key), `provider має отримувати ${key}`);
    assert.ok(step('claude_custom').includes(key), `claude_custom має отримувати ${key}`);
  }
  assert.ok(step('claude').includes("if: steps.provider.outputs.is_custom != 'true'"));
  assert.ok(step('claude_custom').includes("if: steps.provider.outputs.is_custom == 'true'"));
  assert.ok(!step('claude_custom').includes('claude_code_oauth_token'));
  assert.ok(!step('claude_custom').includes('anthropic_api_key'));
  assert.ok(step('finish').includes("steps.provider.outputs.is_custom == 'true' && steps.claude_custom.outcome || steps.claude.outcome"));
  assert.ok(step('finish').includes("steps.provider.outputs.is_custom == 'true' && steps.claude_custom.outputs.execution_file || steps.claude.outputs.execution_file"));
});
