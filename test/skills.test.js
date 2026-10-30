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
