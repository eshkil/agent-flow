// Крок setup: команди `setup` з .kando/agent.yml (передані в env workflow),
// кожна окремим `bash -e`. Перша невдала зупиняє крок.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');
const { writeFailure, tailBuffer } = require('./failure');

// Скільки байт з кінця журналу команди читати для tail: 150 рядків × 500 символів
// кирилицею з запасом. Фоновий сервер може писати в журнал скільки завгодно.
const READ_BYTES = 512 * 1024;

function setupCommands(envJson) {
  let cfg;
  try { cfg = JSON.parse(envJson || '{}'); } catch { throw new Error('env: некоректний JSON'); }
  const s = cfg?.setup;
  const list = Array.isArray(s) ? s : s ? [s] : [];
  return list.map(String).filter(line => line.trim());
}

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const fdOf = s => (Number.isInteger(s?.fd) ? s.fd : 'inherit');
const sizeOf = file => { try { return fs.statSync(file).size; } catch { return -1; } };
const wait = ms => new Promise(r => setTimeout(r, ms));

// Скрипт для BASH_ENV: bash виконує його до рядка команди. stdout і stderr ідуть
// у журнал job як і раніше, а tee додатково дописує їх у файл для tail. BASH_ENV
// одразу знімаємо, щоб дочірні bash-скрипти не перехоплювали вивід удруге.
const captureScript = log =>
  `unset BASH_ENV\ncommand -v tee >/dev/null 2>&1 && exec > >(tee -a ${q(log)}) 2> >(tee -a ${q(log)} >&2)\n`;

// tee пише асинхронно: даємо йому дописати, доки файл росте, але не довше max.
async function settle(file, { step = 50, max = 500 } = {}) {
  let last = sizeOf(file);
  for (let t = 0; t < max; t += step) {
    await wait(step);
    const size = sizeOf(file);
    if (size === last) return;
    last = size;
  }
}

function readTail(file) {
  const tail = tailBuffer();
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - READ_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    // Почали посеред файла — перший рядок неповний, відкидаємо його.
    const from = start > 0 ? buf.indexOf(0x0a) + 1 : 0;
    tail.push(buf.subarray(from));
  } catch { /* журналу немає — tail порожній */ }
  return tail.lines();
}

// Вивід іде прямо в журнал job (stdout/stderr успадковано), тож фоновий процес
// (`npm run dev &`) пише туди й далі, а крок закінчується, щойно вийшов bash, —
// як за spawnSync. Останні рядки для звіту беремо з копії, яку пише tee.
function runOne(spawn, line, out, err, log) {
  return new Promise(resolve => {
    fs.writeFileSync(log, '', { mode: 0o600 });
    fs.writeFileSync(`${log}.sh`, captureScript(log), { mode: 0o600 });
    const p = spawn('bash', ['-e', '-c', line], {
      stdio: ['inherit', fdOf(out), fdOf(err)],
      env: { ...process.env, BASH_ENV: `${log}.sh` },
    });
    // Не вдалося запустити (ENOENT тощо): короткий код — в exit_code, повне повідомлення — в tail.
    p.on('error', e => resolve({ code: null, signal: e.code || 'error', message: e.message }));
    // 'exit', а не 'close': не чекаємо фонових процесів, що тримають вивід.
    p.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function runSetup({ envJson, spawn = nodeSpawn, out = process.stdout, err = process.stderr, env = process.env }) {
  const commands = setupCommands(envJson);
  if (!commands.length) return;
  // Не в $RUNNER_TEMP/kando: там лише звіт, і збій запису звіту не має зупиняти setup.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kando-setup-'));
  try {
    for (const [i, line] of commands.entries()) {
      const log = path.join(dir, `${i}.log`);
      out.write(`::group::setup: ${line}\n`);
      const r = await runOne(spawn, line, out, err, log);
      // Хвіст виводу ще в tee: без паузи він потрапив би вже за ::endgroup::.
      if (!r.message) await settle(log);
      out.write('::endgroup::\n');
      if (r.code !== 0) {
        const code = r.code ?? r.signal;
        let tail;
        if (r.message) {
          const t = tailBuffer();
          t.push(`${r.message}\n`);
          tail = t.lines();
        } else {
          tail = readTail(log);
        }
        // Збій запису звіту не має підміняти справжню помилку setup.
        try { writeFailure(env, { stage: 'setup', command: line, exit_code: code, tail }); } catch { /* звіт не важливіший за сам збій */ }
        throw new Error(`setup: «${line}» завершилась з кодом ${code}`);
      }
    }
  } finally {
    // tee фонового процесу може ще писати — у вже видалений файл, це нешкідливо.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runSetup({ envJson: process.env.KANDO_ENV }).catch(e => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}

module.exports = { setupCommands, runSetup };
