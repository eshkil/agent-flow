// Крок files: «файли поза git» (.env, google-services.json тощо) з секрету репо
// KANDO_FILES. Значення — JSON {"<шлях>": "<вміст у base64>"}; пишемо їх у робочу
// копію ДО setup, щоб команди setup і сам агент їх бачили.
// Вміст секретом і лишається: у лог ідуть лише шляхи, а помилки не несуть ні JSON,
// ні base64 (навіть повідомлення JSON.parse не беремо — воно цитує початок тексту).

const fs = require('node:fs');
const path = require('node:path');

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Дзеркало buildFilesSecret у Kando: відносний шлях без виходу за теку; .git — без
// урахування регістру (APFS/NTFS) і з кінцевими крапками/пробілами, які ці ФС ігнорують.
function badPath(p) {
  if (typeof p !== 'string' || !p.trim()) return true;
  if (p.startsWith('/') || path.isAbsolute(p) || p.includes('\\') || /[\x00-\x1f\x7f]/.test(p)) return true;
  return p.split('/').some(s => s === '' || s === '.' || s === '..' || s.replace(/[. ]+$/, '').toLowerCase() === '.git');
}

const inside = (root, p) => {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// Найглибший наявний предок шляху: через symlink у репо mkdir -p створив би теки
// поза робочою копією, тож реальний шлях предка теж мусить лишатися всередині root.
function checkTarget(realRoot, target) {
  let dir = path.dirname(target);
  while (!fs.existsSync(dir) && !isLink(dir)) dir = path.dirname(dir);
  let real;
  try { real = fs.realpathSync(dir); } catch { throw new Error('шлях проходить через symlink без цілі'); }
  if (!fs.statSync(real).isDirectory()) throw new Error('шлях проходить через файл');
  if (real !== realRoot && !inside(realRoot, real)) throw new Error('шлях виходить за робочу копію');
  if (isLink(target)) throw new Error('на місці файлу symlink');
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// → масив записаних шляхів. Спершу перевіряє ВСІ шляхи, і лише потім пише: поганий
// шлях не лишає після себе половини файлів.
function writeFiles(json, root) {
  if (json == null || !String(json).trim()) return [];
  let map;
  try { map = JSON.parse(json); } catch { throw new Error('files: секрет KANDO_FILES — некоректний JSON'); }
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new Error('files: секрет KANDO_FILES має бути JSON-обʼєктом {шлях: base64}');

  const realRoot = fs.realpathSync(root);
  const plan = [];
  for (const [rel, b64] of Object.entries(map)) {
    if (badPath(rel)) throw new Error(`files: некоректний шлях ${JSON.stringify(rel)}: потрібен відносний шлях усередині репо, не в .git/`);
    if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !BASE64.test(b64)) throw new Error(`files: ${JSON.stringify(rel)}: вміст не в base64`);
    const target = path.resolve(realRoot, rel);
    if (!inside(realRoot, target)) throw new Error(`files: шлях ${JSON.stringify(rel)} виходить за робочу копію`);
    try { checkTarget(realRoot, target); } catch (e) { throw new Error(`files: ${JSON.stringify(rel)}: ${e.message}`); }
    plan.push({ rel, target, data: Buffer.from(b64, 'base64') });
  }

  for (const { target, data, rel } of plan) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Повторно після mkdir: між перевіркою й записом нічого не мало змінитися.
    try { checkTarget(realRoot, target); } catch (e) { throw new Error(`files: ${JSON.stringify(rel)}: ${e.message}`); }
    fs.writeFileSync(target, data, { mode: 0o600 });
    fs.chmodSync(target, 0o600);   // файл міг уже існувати з іншими правами
  }
  return plan.map(f => f.rel);
}

if (require.main === module) {
  try {
    const written = writeFiles(process.env.KANDO_FILES_JSON, process.env.GITHUB_WORKSPACE || process.cwd());
    for (const p of written) console.log(`files: записано ${p}`);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}

module.exports = { writeFiles, badPath };
