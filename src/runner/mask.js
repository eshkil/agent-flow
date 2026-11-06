// Маскування секретів у звіті про збій перед відправкою в Kando. Спершу точні
// значення (довші першими), потім ті самі шаблони токенів, що `maskTokens` у Kando.

const fs = require('node:fs');
const { paths } = require('./kando');

// Коротші рядки файлів із KANDO_FILES не маскуємо свідомо: інакше `true`, `8080`
// чи порожні ключі затерли б пів журналу. Короткий секрет у виводі команди лишиться
// в tail — його бачать лише учасники з правом запису в репо.
const MIN_FILE_LINE = 8;

// Authorization іде першим: він забирає весь рядок разом із токеном.
const TOKEN_PATTERNS = [
  /Authorization:[^\n]*/gi,
  /\bBearer\s+\S+/gi,
  /\bgithub_pat_\w+/g,
  /\bgh[psou]_\w+/g,
  /\bsk-ant-[\w-]+/g,
];

// Рядки файлів «поза git» (KANDO_MASK_FILES = той самий JSON {шлях: base64}, що й
// у кроці files). Збій розбору — файлових значень немає; вміст у помилку не йде.
function fileLines(raw) {
  try {
    const map = JSON.parse(raw);
    if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
    const out = [];
    for (const v of Object.values(map)) {
      if (typeof v !== 'string') continue;
      for (const line of Buffer.from(v, 'base64').toString('utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (t.length >= MIN_FILE_LINE) out.push(t);
      }
    }
    return out;
  } catch { return []; }
}

function secretsFrom(env) {
  const out = [env.KANDO_MASK_CLAUDE_TOKEN, env.KANDO_MASK_API_KEY];
  try { out.push(fs.readFileSync(paths(env).token, 'utf8')); } catch { /* токена ще нема */ }
  if (env.KANDO_MASK_FILES) out.push(...fileLines(env.KANDO_MASK_FILES));
  return [...new Set(out.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean))];
}

function mask(s, secrets = []) {
  let out = String(s);
  for (const v of [...secrets].filter(x => x && x.trim()).sort((a, b) => b.length - a.length)) out = out.split(v).join('***');
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '***');
  return out;
}

module.exports = { secretsFrom, mask };
