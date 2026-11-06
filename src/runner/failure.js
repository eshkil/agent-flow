// Звіт про збій кроку раннера: failure.json у $RUNNER_TEMP/kando. Його читає finish
// і передає Kando, щоб у картці було видно, що саме впало. Перший збій виграє:
// наступні кроки не затирають першопричину.

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { paths } = require('./kando');

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const MAX_LINE = 500;
const MAX_PARTIAL = 8192;
// Kando зберігає звіт ≤ 48 КБ; більший запит HTTP-парсер відхилив би цілком (413),
// і разом зі звітом пропав би підсумок запуску.
const MAX_BYTES = 48 * 1024;

const failurePath = env => path.join(paths(env).dir, 'failure.json');

const cap = x => String(x).slice(0, MAX_LINE);

// Kando відкидає звіт цілком, якщо поле вийшло за ліміт, тож зводимо все до меж:
// exit_code — число або рядок ≤ 20, command і рядки tail — ≤ 500.
function normalize({ stage, command, exit_code, tail }) {
  return {
    stage,
    command: command == null ? null : cap(command),
    exit_code: exit_code == null ? null : typeof exit_code === 'number' ? exit_code : String(exit_code).slice(0, 20),
    tail: (tail || []).map(cap),
  };
}

// → true, якщо записали; false, якщо звіт уже є.
function writeFailure(env, report) {
  const file = failurePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = { ...normalize(report), runner_os: env.RUNNER_OS, runner_arch: env.RUNNER_ARCH };
  try {
    fs.writeFileSync(file, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  return true;
}

// Звіт у межах max байт (UTF-8, після серіалізації): найстаріші рядки tail
// відкидаються, найновіші — поруч зі збоєм — лишаються. Вхід не змінюється.
function fitFailure(failure, max = MAX_BYTES) {
  if (!Array.isArray(failure.tail)) return failure;
  const tail = failure.tail.slice();
  const size = () => Buffer.byteLength(JSON.stringify({ ...failure, tail }), 'utf8');
  while (tail.length && size() > max) tail.shift();
  return { ...failure, tail };
}

// Останні max рядків виводу. Кожен потік (stdout, stderr) має свій декодер і свій
// незавершений рядок, тож недописаний рядок одного потоку не склеюється з іншим, а
// кириличний символ, розрізаний між шматками, лишається цілим. Завершені рядки
// йдуть у спільний список у порядку надходження. ANSI знімається, службові команди
// Actions (`::…`) пропускаються, `\r`-прогрес лишає текст після останнього `\r`,
// довгі рядки обрізаються до 500, а незавершений — до 8 КБ ще в буфері.
// `push` — потік за замовчуванням; `stream()` дає окремий.
function tailBuffer(max = 150) {
  const done = [];
  const clean = raw => {
    // Кінцевий \r — частина CRLF, а не прогрес: спершу знімаємо його.
    const text = raw.replace(ANSI, '').replace(/\r+$/, '');
    return text.slice(text.lastIndexOf('\r') + 1);
  };
  const keep = raw => {
    const line = clean(raw);
    if (line.startsWith('::')) return;
    done.push(line.slice(0, MAX_LINE));
    if (done.length > max) done.shift();
  };
  const stream = () => {
    const dec = new StringDecoder('utf8');
    let partial = '';
    return {
      push(chunk) {
        const parts = (partial + (typeof chunk === 'string' ? chunk : dec.write(chunk))).split('\n');
        partial = parts.pop().slice(-MAX_PARTIAL);
        parts.forEach(keep);
      },
      partial: () => partial, // без dec.end(): повторний lines() не псує стан декодера
    };
  };
  const streams = [];
  const main = stream();
  streams.push(main);
  return {
    push: c => main.push(c),
    stream() { const s = stream(); streams.push(s); return s; },
    lines() {
      const all = done.slice();
      for (const s of streams) {
        const line = clean(s.partial());
        if (line && !line.startsWith('::')) all.push(line.slice(0, MAX_LINE));
      }
      return all.slice(-max);
    },
  };
}

module.exports = { failurePath, writeFailure, fitFailure, tailBuffer };
