// Крок preflight: чи є на runner-і утиліти, без яких запуск не дасть результату.
// Стоїть після setup: його команди можуть ці утиліти доставити.
//
// Перевіряємо саме запуском, а не `command -v`: start.js додає в PATH обгортку bin/gh,
// тож `command -v gh` знайде її навіть без справжнього gh. Обгортка тоді виходить із кодом 127.
// Тому env мусить містити PATH з bin/ (так і є: start.js додає його в GITHUB_PATH), а зміна
// коду виходу обгортки (127 у bin/gh, коли справжнього gh нема) зламає цю перевірку — на
// це є тест у test/runner-preflight.test.js.
//
// Збій кроку пропускає Claude. Перелік із виходу missing крок finish передає Kando,
// а той будує причину з командою встановлення.

const { spawnSync } = require('node:child_process');
const { fileOutput } = require('../output');

const TOOLS = [['git', '--version'], ['gh', '--version'], ['unzip', '-v']];
const TIMEOUT_MS = 30e3;

function missingTools({ env, spawn = spawnSync }) {
  return TOOLS
    .filter(([tool, flag]) => spawn(tool, [flag], { env, stdio: 'ignore', timeout: TIMEOUT_MS }).status !== 0)
    .map(([tool]) => tool);
}

function preflight({ env, spawn, setOutput = () => {}, log = console }) {
  const missing = missingTools({ env, spawn });
  setOutput('missing', missing.join(' '));
  if (missing.length) throw new Error(`На runner-і немає утиліт: ${missing.join(', ')}`);
  log.log(`Утиліти на місці: ${TOOLS.map(([tool]) => tool).join(', ')}`);
}

if (require.main === module) {
  try {
    preflight({ env: process.env, setOutput: fileOutput(process.env.GITHUB_OUTPUT) });
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}

module.exports = { missingTools, preflight };
