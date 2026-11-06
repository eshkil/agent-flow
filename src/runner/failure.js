// Звіт про збій кроку раннера: failure.json у $RUNNER_TEMP/kando. Його читає finish
// і передає Kando, щоб у картці було видно, що саме впало. Перший збій виграє:
// наступні кроки не затирають першопричину.

const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('./kando');

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const MAX_LINE = 500;

const failurePath = env => path.join(paths(env).dir, 'failure.json');

// → true, якщо записали; false, якщо звіт уже є.
function writeFailure(env, { stage, command, exit_code, tail }) {
  const file = failurePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = { stage, command, exit_code, tail, runner_os: env.RUNNER_OS, runner_arch: env.RUNNER_ARCH };
  try {
    fs.writeFileSync(file, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  return true;
}

// Останні max рядків виводу: шматки склеюються за \n, ANSI знімається, службові
// команди Actions (`::…`) не беремо, довгі рядки обрізаємо.
function tailBuffer(max = 150) {
  const done = [];
  let partial = '';
  const keep = raw => {
    const line = raw.replace(ANSI, '').replace(/\r$/, '');
    if (line.startsWith('::')) return;
    done.push(line.slice(0, MAX_LINE));
    if (done.length > max) done.shift();
  };
  return {
    push(chunk) {
      const parts = (partial + String(chunk)).split('\n');
      partial = parts.pop();
      parts.forEach(keep);
    },
    lines() {
      if (!partial) return done.slice();
      const all = done.slice();
      const line = partial.replace(ANSI, '');
      if (!line.startsWith('::')) all.push(line.slice(0, MAX_LINE));
      return all.slice(-max);
    },
  };
}

module.exports = { failurePath, writeFailure, tailBuffer };
