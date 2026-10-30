// Крок setup: команди `setup` з .kando/agent.yml (передані в env workflow),
// кожна окремим `bash -e`. Перша невдала зупиняє крок.

const { spawnSync } = require('node:child_process');

function setupCommands(envJson) {
  let cfg;
  try { cfg = JSON.parse(envJson || '{}'); } catch { throw new Error('env: некоректний JSON'); }
  const s = cfg?.setup;
  const list = Array.isArray(s) ? s : s ? [s] : [];
  return list.map(String).filter(line => line.trim());
}

function runSetup({ envJson, spawn = spawnSync, log = console }) {
  for (const line of setupCommands(envJson)) {
    log.log(`::group::setup: ${line}`);
    const r = spawn('bash', ['-e', '-c', line], { stdio: 'inherit' });
    log.log('::endgroup::');
    if (r.status !== 0) throw new Error(`setup: «${line}» завершилась з кодом ${r.status ?? r.signal}`);
  }
}

if (require.main === module) {
  try { runSetup({ envJson: process.env.KANDO_ENV }); } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}

module.exports = { setupCommands, runSetup };
