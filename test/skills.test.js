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

// Локальна сесія Claude Code повідомляє Kando, що тримає задачу (plugin/bin/kando-session).
// Усі сім скілів мають однакові кроки «взяти» і «відпустити», лише з різним --skill.
const SESSION_SKILLS = ['triage', 'feature-spec', 'bug-agent', 'implement', 'pr-review', 'pr-fix', 'merge'];

for (const name of SESSION_SKILLS) {
  test(`${name}: кроки «взяти» і «відпустити» задачу в Kando`, () => {
    const s = skill(name);
    const begin = s.indexOf('"${CLAUDE_PLUGIN_ROOT}/bin/kando-session" begin --session "${CLAUDE_SESSION_ID}"');
    const end = s.indexOf('"${CLAUDE_PLUGIN_ROOT}/bin/kando-session" end --session "${CLAUDE_SESSION_ID}"');
    assert.ok(begin > 0, 'є команда begin');
    assert.ok(end > begin, 'end після begin');
    assert.equal(s.split('kando-session" begin').length, 2, 'begin один раз');
    assert.equal(s.split('kando-session" end').length, 2, 'end один раз');

    const beginLine = s.slice(begin, s.indexOf('\n', begin));
    assert.ok(beginLine.includes(`--skill ${name}`), 'назва скіла в --skill');
    assert.match(beginLine, /--number /);

    const takeSection = s.slice(s.lastIndexOf('\n## ', begin), s.indexOf('\n## ', begin));
    assert.match(takeSection, /Контекст запуску \(диспетчер agent-flow\)/, 'пропуск під диспетчером');
    assert.match(takeSection, /незаміненими змінними чи файла скрипта немає/, 'пропуск без скрипта чи змінних');
    assert.match(takeSection, /Код виходу `3`/);
    assert.match(takeSection, /передай людині вивід/);
    assert.match(takeSection, /--takeover/);
    assert.match(takeSection, /лише за явним рішенням людини/);
    assert.match(takeSection, /задачу втрачено/i);
    assert.match(takeSection, /не запускай `begin` повторно/);
    assert.match(takeSection, /на кожному шляху зупинки після взяття/);
    // Про takeover не кажемо «сам»: рішення завжди за людиною.
    for (const line of takeSection.split('\n').filter(l => l.includes('--takeover'))) assert.doesNotMatch(line, /\bсам(а|і|ому)?\b/);

    const endSection = s.slice(s.lastIndexOf('\n## ', end), s.indexOf('\n## ', end));
    assert.match(endSection, /Контекст запуску \(диспетчер agent-flow\)/);
    assert.match(endSection, /на кожному шляху зупинки після взяття/);

    // Якорі мають існувати: жодних порожніх шляхів у перевірках.
    const step0 = s.search(/^## Крок 0/m);
    assert.ok(step0 >= 0, 'є крок 0');
    assert.ok(begin > step0, 'begin після кроку 0');
    const firstChange = s.search(/Постав `ai:in-progress`|--add-label|gh (issue|pr) (edit|comment|close)|Перевір кожну умову/);
    assert.ok(firstChange >= 0, 'є зміна стану');
    assert.ok(begin < firstChange, 'begin до першої зміни стану');
    const stopEnd = s.indexOf('\n## Заборонено');
    assert.ok(stopEnd >= 0, 'є «Заборонено»');
    assert.ok(end < stopEnd, 'end перед «Заборонено»');
    const lastStep = [...s.matchAll(/^## Крок \d+\./gm)].pop();
    assert.ok(lastStep, 'є нумеровані кроки');
    assert.ok(end > lastStep.index, 'end після останнього нумерованого кроку');

    // Втрачена задача: end не викликати.
    assert.match(takeSection, /`end` \*\*не виконуй\*\*/);
    assert.match(takeSection, /крім випадку, коли задачу втрачено/);
    assert.match(endSection, /втрачена задача/);
    // У реченні про умову пропуску немає літералів змінних.
    assert.doesNotMatch(takeSection.split('\n').find(l => l.startsWith('Пропусти')), /\$\{/);
    assert.doesNotMatch(endSection.split('\n').find(l => l.startsWith('Пропусти')), /\$\{/);
  });
}

// Зупинки, де скіл чекає людину чи здається, — після begin; на місці зупинки має стояти «Відпустити».
const RELEASE = 'Виконай крок «Відпустити задачу в Kando»';
const STOP_SITES = {
  'bug-agent': ['напиши, який саме крок не вдалося виконати й чому.', 'це продуктове рішення → `needs-human`.', 'Це нормальний і очікуваний результат, а не поразка.'],
  implement: ['чим можна довести критерії.', 'Не переписуй завдання на ходу.'],
  'pr-fix': ['Для повторного рев\'ю — `agent:go`.» і зупинись.', 'виправ або зупинись із `needs-human`.', '2–3 варіанти рішення.'],
  merge: ['і **зупинись без дій**.'],
};
for (const [name, markers] of Object.entries(STOP_SITES)) {
  test(`${name}: на кожній зупинці після begin є «Відпустити»`, () => {
    const s = skill(name);
    const begin = s.indexOf('kando-session" begin');
    for (const m of markers) {
      const i = s.indexOf(m);
      assert.ok(i > begin && begin > 0, `маркер після begin: ${m}`);
      assert.equal(s.split(m).length, 2, `маркер унікальний: ${m}`);
      assert.ok(s.slice(i, i + m.length + RELEASE.length + 4).includes(RELEASE), `після «${m}» немає «Відпустити»`);
    }
  });
}

test('triage: begin після зупинок кроку 0б (закритий, ai:triaged, ai:in-progress, needs-human)', () => {
  const s = skill('triage');
  const stops = s.indexOf('- є лейбл `needs-human` і немає явної команди людини.');
  const begin = s.indexOf('kando-session" begin');
  const label = s.indexOf('Постав `ai:in-progress` і працюй');
  assert.ok(stops > 0 && begin > stops && label > begin);
});

test('pr-fix: перевірка закритого PR — до begin', () => {
  const s = skill('pr-fix');
  const closed = s.indexOf('PR закритий або змерджений');
  const begin = s.indexOf('kando-session" begin');
  const label = s.indexOf('Постав `ai:in-progress` на PR');
  assert.ok(closed > 0 && begin > closed && label > begin);
});

test('скіли: нейтральні до редактора — в інших редакторах кроки пропускаються', () => {
  for (const name of SESSION_SKILLS) {
    assert.match(skill(name), /інший редактор/, name);
  }
});

test('шаблони CI не викликають kando-session', () => {
  const tpl = fs.readdirSync(path.join(__dirname, '..', 'templates'));
  for (const f of tpl) {
    assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'templates', f), 'utf8').includes('kando-session'), f);
  }
});
