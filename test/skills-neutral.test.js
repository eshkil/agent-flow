// Скіли мають бути нейтральними до репозиторію (працювати в чужому проєкті), але
// службові маркери, на які спирається Kando, лишаються дослівними.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SKILLS = path.join(__dirname, '..', 'plugin', 'skills');
const names = fs.readdirSync(SKILLS).filter(n => fs.existsSync(path.join(SKILLS, n, 'SKILL.md'))).sort();
const skill = name => fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
// Без блоку «Пріоритет проєкту» (він сам перелічує маркери): перевіряємо тіло скіла.
const body = name => skill(name).replace(/## Пріоритет проєкту[\s\S]*?\n(?=## )/, '');

test('є всі сім скілів', () => {
  assert.deepEqual(names, ['bug-agent', 'feature-spec', 'implement', 'merge', 'pr-fix', 'pr-review', 'triage']);
});

for (const name of names) {
  test(`${name}: блок «Пріоритет проєкту» на початку, одразу після заголовка`, () => {
    const s = skill(name);
    const i = s.indexOf('## Пріоритет проєкту');
    assert.ok(i > 0, 'блок є');
    const h1 = s.search(/^# /m);
    assert.ok(h1 >= 0 && h1 < i && s.slice(h1, i).split('\n').length <= 4, 'блок іде одразу під заголовком скіла');
    const block = s.slice(i, s.indexOf('\n## ', i + 1));
    assert.match(block, /`CLAUDE\.md` \/ `AGENTS\.md`/);
    assert.match(block, /пріоритет над цим скілом/);
    assert.match(block, /мова тікета/);
    assert.match(block, /`docs\/evidence\/`/);
    assert.match(block, /дослівно, незалежно від мови/);
  });

  test(`${name}: немає специфіки репо автора`, () => {
    const s = skill(name);
    for (const bad of ['kando-board', 'eshkil/', 'backend/']) assert.ok(!s.includes(bad), `«${bad}» у скілі`);
  });
}

// Маркери, що існують у скілах сьогодні, — у тих самих скілах і тих самих рядках.
const PINNED = {
  triage: [
    '## 🔍 Тріаж',
    '**❓ Потрібно уточнити:**',
    '<sub>🤖 Автоматичний тріаж · [як працює пайплайн](../blob/<BASE>/PIPELINE.md)</sub>',
  ],
  'feature-spec': ['<sub>🤖 Автоматична специфікація · макет накладено в браузері, код проєкту не змінювався</sub>'],
  implement: [
    "<sub>🤖 Автоматична імплементація · рев'ю — `agent:go`, мердж — Approve + `agent:go`</sub>",
    '`<!-- kando:draft-reason: <одне речення, чому draft> -->`',
  ],
  'bug-agent': [
    "<sub>🤖 Автоматичний фікс · рев'ю — `agent:go`, мердж — Approve + `agent:go`</sub>",
    '`<!-- kando:draft-reason: <одне речення, чому draft> -->`',
  ],
  'pr-review': [
    "## 🤖 Код-рев'ю",
    "<sub>🤖 Автоматичне рев'ю · не замінює людський апрув</sub>",
  ],
  'pr-fix': ['<sub>🤖 Доопрацювання PR</sub>'],
  merge: ['- Схвалення в Kando: @<login> на коміті <sha>'],
};

for (const [name, markers] of Object.entries(PINNED)) {
  test(`${name}: службові маркери дослівно`, () => {
    const s = body(name);
    for (const m of markers) assert.ok(s.includes(m), `немає маркера ${m}`);
  });
}

test('triage: тріаж-коментар і «Потрібно уточнити» (контракт з Kando)', () => {
  const s = body('triage');
  assert.ok(s.includes('## 🔍 Тріаж'));
  assert.ok(s.includes('❓ Потрібно уточнити'));
});

test('скіли, що вміють лишати draft, згадують маркер draft-reason; npm не єдиний варіант', () => {
  for (const n of ['implement', 'bug-agent']) assert.ok(body(n).includes('kando:draft-reason'));
  assert.match(body('implement'), /npm test`, `pytest`/);
  assert.match(body('bug-agent'), /з README\/CLAUDE\.md/);
});
