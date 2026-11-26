// README описує контракт автоциклу з Kando: перевіряємо, що він збігається зі скілами.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const readme = () => fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const skill = name => fs.readFileSync(path.join(__dirname, '..', 'plugin', 'skills', name, 'SKILL.md'), 'utf8');

const STATE_RULE = 'Стан пункту — останній довірений запис по його `id` у блоках `kando:triage` і `kando:fix`, від старих до нових: пізніший запис перекриває ранній.';
const ROUND_RULE = 'Коло `N` — номер рев\'ю в ланцюжку PR: перше рев\'ю — коло 1, рев\'ю після `k`-го доопрацювання — коло `k+1` (може перевищити `M`); розбір і доопрацювання мають `N` того рев\'ю, яке обробляють.';

test('README: стан пункту і визначення кола — ті самі, що в скілах', () => {
  const r = readme();
  for (const rule of [STATE_RULE, ROUND_RULE]) {
    assert.ok(r.includes(rule));
    for (const name of ['pr-review', 'review-triage', 'pr-fix']) assert.ok(skill(name).includes(rule), `${name}: ${rule}`);
  }
});
test('README: немає довіреного kando:triage для поточного review_head — зупинка для людини', () => {
  assert.match(readme(), /немає довіреного `kando:triage`[^\n]*\n?[^\n]*зупинк[^\n]*\n?[^\n]*людин[^\n]*\n?[^\n]*не «чекає Approve»/);
});
test('README: path і line — null для зауваження без місця', () => {
  assert.match(readme(), /`path` і `line` — `null`[^\n]*без місця/);
});
test('README: коментар Kando про незгоду (`<sub>🤖 Kando</sub>`) — не H', () => {
  assert.match(readme(), /`<sub>🤖 Kando<\/sub>`[^\n]*\n?[^\n]*не `H`/);
});
test('README: pr-review ігнорує недовірені блоки, triage і pr-fix зупиняються; вікно H як у скілі', () => {
  const r = readme();
  assert.match(r, /`pr-review` недовірені блоки просто не враховує[^\n]*\n?[^\n]*`review-triage` і `pr-fix`[^\n]*зупиняються/);
  assert.doesNotMatch(r, /крок зупиняється/);
  assert.match(r, /`H<n>` — коментарі людей із правом запису, написані після розбору попереднього кола/);
});
test('README: kando:fix містить review_head, як у pr-fix', () => {
  const block = '{"v":1,"round":<N>,"review_head":"<sha>","fixed":["R1"],"not_fixed":[{"id":"R2","reason":"…"}]}';
  assert.ok(readme().includes('`kando:fix` — `' + block + '`'));
  assert.ok(skill('pr-fix').includes('<!-- kando:fix ' + block + ' -->'));
});

// Рев'ю PR #37, R1: head PR між колами може не змінитися, тож коло — пара review_head і round.
const PAIR_RULE = 'Коло блоку — пара `review_head` і `round` (у `kando:review` — `head` і `round`): head PR між колами може не змінитися (доопрацювання, яке нічого не виправило, не пушить), тож попереднє коло від повтору цього ж розбору відрізняє пара, а не лише `review_head`.';
test('README і скіли: коло блоку — пара review_head і round', () => {
  assert.ok(readme().includes(PAIR_RULE), 'README');
  for (const name of ['pr-review', 'review-triage', 'pr-fix']) assert.ok(skill(name).includes(PAIR_RULE), name);
  assert.match(readme(), /для `head` і `round` найновішого довіреного рев'ю немає довіреного `kando:triage`/);
});

// Рев'ю PR #37, R2: довіра до будь-якого бота — описане обмеження.
test('README: довіра до бота за типом, а не за логіном — описано ризик', () => {
  const r = readme();
  assert.match(r, /бот довіряється за типом \(`user\.type == "Bot"`\), а не за логіном/);
  assert.match(r, /`github-actions\[bot\]`/);
  assert.match(r, /не вмикайте автоцикл/);
});
