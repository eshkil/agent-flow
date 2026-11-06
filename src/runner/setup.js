// Крок setup: команди `setup` з .kando/agent.yml (передані в env workflow),
// кожна окремим `bash -e`. Перша невдала зупиняє крок.

const { spawn: nodeSpawn } = require('node:child_process');
const { writeFailure, tailBuffer } = require('./failure');

function setupCommands(envJson) {
  let cfg;
  try { cfg = JSON.parse(envJson || '{}'); } catch { throw new Error('env: некоректний JSON'); }
  const s = cfg?.setup;
  const list = Array.isArray(s) ? s : s ? [s] : [];
  return list.map(String).filter(line => line.trim());
}

// Вивід іде в лог одразу (довгий setup не мовчить), а останні рядки лишаються для звіту.
function runOne(spawn, line, out, err) {
  return new Promise(resolve => {
    const tail = tailBuffer();
    const p = spawn('bash', ['-e', '-c', line], { stdio: ['inherit', 'pipe', 'pipe'] });
    p.stdout.on('data', c => { out.write(c); tail.push(c); });
    p.stderr.on('data', c => { err.write(c); tail.push(c); });
    p.on('error', e => resolve({ code: null, signal: e.message, tail: tail.lines() }));
    p.on('close', (code, signal) => resolve({ code, signal, tail: tail.lines() }));
  });
}

async function runSetup({ envJson, spawn = nodeSpawn, out = process.stdout, err = process.stderr, env = process.env }) {
  for (const line of setupCommands(envJson)) {
    out.write(`::group::setup: ${line}\n`);
    const r = await runOne(spawn, line, out, err);
    out.write('::endgroup::\n');
    if (r.code !== 0) {
      const code = r.code ?? r.signal;
      writeFailure(env, { stage: 'setup', command: line, exit_code: code, tail: r.tail });
      throw new Error(`setup: «${line}» завершилась з кодом ${code}`);
    }
  }
}

if (require.main === module) {
  runSetup({ envJson: process.env.KANDO_ENV }).catch(e => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}

module.exports = { setupCommands, runSetup };
