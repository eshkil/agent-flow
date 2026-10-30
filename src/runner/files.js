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
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};

// Перший сегмент відносно root — .git (без урахування регістру): symlink усередині
// репо не мусить дати записати файл у службову теку git.
const inGitDir = (root, p) => {
  const first = path.relative(root, p).split(path.sep)[0];
  return first.toLowerCase() === '.git';
};

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// Найглибший наявний предок шляху: через symlink у репо mkdir -p створив би теки
// поза робочою копією, тож реальний шлях предка теж мусить лишатися всередині root
// і не потрапляти в .git.
function checkTarget(realRoot, target) {
  let dir = path.dirname(target);
  while (!fs.existsSync(dir) && !isLink(dir)) dir = path.dirname(dir);
  let real;
  try { real = fs.realpathSync(dir); } catch { throw new Error('шлях проходить через symlink без цілі'); }
  if (!fs.statSync(real).isDirectory()) throw new Error('шлях проходить через файл');
  if (real !== realRoot && !inside(realRoot, real)) throw new Error('шлях виходить за робочу копію');
  if (real !== realRoot && inGitDir(realRoot, real)) throw new Error('шлях веде в .git');
  if (isLink(target)) throw new Error('на місці файлу symlink');
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) throw new Error('на місці файлу тека');
}

// Шаблон .git/info/exclude для точного шляху від кореня: екрануємо знаки glob-у, а
// останній кінцевий пробіл — інакше git його відкидає. Початок `/` знімає проблему з `#`/`!`.
const excludeLine = rel => '/' + rel.replace(/[\\*?[\]]/g, '\\$&').replace(/ $/, '\\ ');

// Записаним секретам не місце в PR: агент комітить із цієї копії, а .env може не бути
// в .gitignore. Дописуємо шляхи в локальний .git/info/exclude (репо не змінюється).
// Немає .git (або це не тека, як у worktree) — мовчки пропускаємо.
function excludeFromGit(root, rels) {
  const gitDir = path.join(root, '.git');
  let st;
  try { st = fs.lstatSync(gitDir); } catch { return; }
  if (!st.isDirectory()) return;
  const file = path.join(gitDir, 'info', 'exclude');
  if (isLink(file)) return;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* файлу ще немає */ }
  const have = new Set(text.split('\n'));
  const add = rels.map(excludeLine).filter(l => !have.has(l));
  if (!add.length) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text + (text && !text.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
  } catch { throw new Error('files: не вдалося оновити .git/info/exclude'); }
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
  // `a` і `a/b` разом: перший стане файлом, другому потрібна тека.
  const rels = new Set(plan.map(f => f.rel));
  for (const { rel } of plan) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (rels.has(parts.slice(0, i).join('/'))) throw new Error(`files: ${JSON.stringify(rel)}: шлях проходить через інший файл секрету`);
    }
  }

  excludeFromGit(realRoot, plan.map(f => f.rel));
  for (const { target, data, rel } of plan) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Повторно після mkdir: між перевіркою й записом нічого не мало змінитися.
      try { checkTarget(realRoot, target); } catch (e) { throw new Error(`files: ${JSON.stringify(rel)}: ${e.message}`); }
      // Права ДО запису: наявний файл міг бути 0644, а writeFile mode йому не міняє.
      if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
      fs.writeFileSync(target, data, { mode: 0o600 });
    } catch (e) {
      if (e.message.startsWith('files: ')) throw e;
      throw new Error(`files: не вдалося записати ${JSON.stringify(rel)}`);
    }
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
