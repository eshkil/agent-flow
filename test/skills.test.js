// Тексти скілів, від яких залежить безпека режиму C: перевіряємо, що правило
// записане саме так, як його очікує Kando (рядок промпту), і з тими обмеженнями.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const skill = name => fs.readFileSync(path.join(__dirname, '..', 'plugin', 'skills', name, 'SKILL.md'), 'utf8');

test('merge: схвалення в Kando — рядок з «Контексту запуску», лише на поточному headRefOid', () => {
  const s = skill('merge');
  // Формат рядка, який пише Kando (backend/agent/prompt.js).
  assert.ok(s.includes('- Схвалення в Kando: @<login> на коміті <sha>'), 'формат рядка промпту');
  assert.match(s, /`<sha>` == `headRefOid`/);
  assert.match(s, /лише з блоку «Контекст запуску»/);
  // Агент має токен App і сам міг би написати такий коментар чи рев'ю.
  assert.match(s, /не з рев'ю чи коментарів GitHub/);
  // Право запису людини все одно перевіряється, решта гейту — без змін.
  const step3 = s.slice(s.indexOf('3. Approve людини'), s.indexOf('4. Перевірки'));
  assert.match(step3, /collaborators\/<login>\/permission/);
  assert.match(step3, /Схвалення в Kando/);
});

// Макети специфікацій — у спільну службову гілку kando-attachments (як картинки з issues у Kando,
// backend/github/attachments.js), а не окрема гілка ai/<N>-spec-mockup на кожну спеку.
test('feature-spec: макети в kando-attachments/specs/<N>/ через Contents API, без гілки на кожну спеку', () => {
  const s = skill('feature-spec');
  assert.doesNotMatch(s, /-b ai\/\$ISSUE-spec-mockup/, 'більше не створює гілку на спеку');
  assert.doesNotMatch(s, /^\s*git\b.*\bpush\b/m, 'жодної команди git push: лише Contents API (без конфліктів між паралельними агентами)');
  assert.match(s, /kando-attachments/);
  assert.match(s, /specs\/\$ISSUE\//);
  assert.match(s, /-X PUT "repos\/\$REPO\/contents\//);
  assert.match(s, /parents":\[\]/, 'гілки нема — orphan, як у Kando');
  // Посилання — за видимістю, на нову гілку.
  assert.match(s, /raw\.githubusercontent\.com\/\$REPO\/kando-attachments\/specs\/\$ISSUE\//);
  assert.match(s, /github\.com\/\$REPO\/blob\/kando-attachments\/specs\/\$ISSUE\/[^\s`]*\?raw=true/);
  assert.match(s, /PNG у `kando-attachments\/specs\/\$ISSUE\/` — єдине, що цьому скілу дозволено писати в репозиторій/);
});

test('merge: старі гілки ai/<N>-spec-mockup і kando-attachments не видаляє', () => {
  const s = skill('merge');
  assert.match(s, /ai\/<N>-spec-mockup/);
  assert.match(s, /kando-attachments/);
});
