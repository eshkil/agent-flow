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
    // Скіл може працювати з іншим репо, ніж origin: тримання не має сісти не на ту задачу.
    assert.ok(beginLine.includes('--repo "$REPO"'), 'репо передано явно');
    assert.ok(s.indexOf('REPO') < begin, '$REPO відомий до begin');

    const takeSection = s.slice(s.lastIndexOf('\n## ', begin), s.indexOf('\n## ', begin));
    assert.match(takeSection, /Контекст запуску \(диспетчер agent-flow\)/, 'пропуск під диспетчером');
    // Лише про змінні самого Claude Code: `$REPO` у команді теж незамінена змінна, але він не привід пропускати.
    assert.match(takeSection, /незаміненими змінними `CLAUDE_…` чи файла скрипта немає/, 'пропуск без скрипта чи змінних');
    assert.match(takeSection, /Код виходу `3`/);
    // allowed-tools покриває лише сам виклик: будь-який хвіст дає запит дозволу чи відмову.
    assert.match(takeSection, /окремим викликом Bash, рівно як написано: без `; echo`, `&&` чи `\|`/);
    assert.match(takeSection, /передай людині вивід/);
    assert.match(takeSection, /--takeover/);
    assert.match(takeSection, /лише за явним рішенням людини/);
    // Перебрати можна лише свою сесію (спека, «Перебрати свою сесію»).
    assert.doesNotMatch(takeSection, /перебрати чужу сесію/);
    assert.match(takeSection, /інша твоя сесія/);
    assert.match(takeSection, /Чужу сесію чи запуск Kando перебрати не можна/);
    assert.match(takeSection, /задачу втрачено/i);
    assert.match(takeSection, /не запускай `begin` повторно/);
    assert.match(takeSection, /на кожному шляху зупинки після взяття/);
    // Про takeover не кажемо «сам»: рішення завжди за людиною.
    for (const line of takeSection.split('\n').filter(l => l.includes('--takeover'))) assert.doesNotMatch(line, /\bсам(а|і|ому)?\b/);

    const endSection = s.slice(s.lastIndexOf('\n## ', end), s.indexOf('\n## ', end));
    assert.match(endSection, /Контекст запуску \(диспетчер agent-flow\)/);
    assert.match(endSection, /окремим викликом Bash, рівно як написано/);
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
    // Після «Відпустити» пуші заблоковані на всю сесію: вихід є, але рішення за людиною.
    assert.match(takeSection, /людина прямо вирішила кинути задачу[^\n]*виконай `end`/);
    assert.match(takeSection, /Сам цього не роби/);
    assert.match(takeSection, /не чіпай лейбли/);
    // Правило «знімай завжди» не сміє суперечити втраченій задачі: це зрушило б картку під чужим запуском.
    for (const m of s.matchAll(/^.*`ai:in-progress`.*(?:за будь-якого|\*\*завжди\*\*|\*\*за будь-якого\*\*).*$/gm)) {
      assert.match(m[0], /крім втраченої задачі/, m[0]);
    }
    // Людина без Kando не мусить підтверджувати скрипт, що для неї нічого не робить.
    const fm = s.slice(0, s.indexOf('\n---', 4));
    // Виклик у скілі: "${CLAUDE_PLUGIN_ROOT}/bin/kando-session" begin — після імені може бути лапка, а не пробіл.
    assert.match(fm, /^allowed-tools: .*Bash\(\*\/bin\/kando-session \*\)/m);
    assert.match(fm, /^allowed-tools: .*Bash\(\*\/bin\/kando-session" \*\)/m);
    // Код 3 каже й про перебирання, яке не вдалось: скіл працює далі лише на результат без коду 3.
    assert.match(takeSection, /Код виходу `3` означає, що задачу вже тримає хтось інший або перебрати її не вдалось/);
    // Кинуту задачу лейбл не тримає, але чужий запуск він не має зрушити: це підтверджує людина.
    if (/Постав `ai:in-progress`/.test(s)) {
      assert.match(takeSection, /виконай `end`[^\n]*`ai:in-progress` зніми, лише якщо людина підтвердить/);
    }
    assert.match(endSection, /хіба що людина вирішила кинути задачу/);
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
  'bug-agent': ['напиши, який саме крок не вдалося виконати й чому.', 'і 2–3 уточнювальні питання авторові. Не закривай тікет.', 'це продуктове рішення → `needs-human`.', 'Це нормальний і очікуваний результат, а не поразка.'],
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

// Після kill -9 лишається ai:in-progress: нова сесія зупинилась би на лейблі ще до begin і ніколи
// не дійшла б до --takeover.
for (const name of ['triage', 'feature-spec', 'bug-agent']) {
  test(`${name}: явна команда людини перебрати задачу знімає зупинку на ai:in-progress`, () => {
    const s = skill(name);
    const begin = s.indexOf('kando-session" begin');
    const i = s.indexOf('Людина прямо наказала перебрати задачу');
    assert.ok(i > 0 && i < begin, 'виняток стоїть до begin, поруч із зупинкою');
    const para = s.slice(i, s.indexOf('\n\n', i));
    assert.match(para, /`ai:in-progress`/);
    assert.match(para, /`--takeover`/);
    assert.match(para, /«закріплено» доводить, що лейбл застарілий/);
    // no-managed, немає токена, код 3: лейбл нічим не спростовано.
    assert.match(para, /Будь-який інший вивід цього не доводить: зупинись/);
  });
}

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

// #26: pr-review і merge позначають роботу лейблом ai:in-progress на самому PR (не на задачі),
// щоб Kando показав «у роботі поза Kando», і знімають його на кожному виході.
for (const name of ['pr-review', 'merge']) {
  test(`${name}: ai:in-progress ставиться на PR після begin і кроку 0`, () => {
    const s = skill(name);
    const begin = s.indexOf('kando-session" begin');
    const step0 = s.search(/^## Крок 0\./m);
    const put = s.indexOf('Постав `ai:in-progress` на PR');
    assert.ok(put > 0, 'є «Постав `ai:in-progress` на PR»');
    assert.ok(step0 >= 0 && begin > step0 && put > begin, 'після кроку 0 і begin');
    assert.ok(s.indexOf('--add-label ai:in-progress') > begin, 'команда постановки');
    for (const line of s.split('\n').filter(l => l.includes('ai:in-progress'))) {
      assert.doesNotMatch(line, /\$ISSUE|closingIssuesReferences|gh issue edit/, line);
    }
    for (const m of s.matchAll(/gh \S+ edit [^\n]*ai:in-progress/g)) {
      assert.match(m[0], /^gh pr edit \$PR -R "\$REPO" --(add|remove)-label ai:in-progress/, m[0]);
    }
    assert.ok(s.indexOf('--remove-label ai:in-progress') > put, 'є зняття');
  });

  test(`${name}: лейбли agent:* не змінюються`, () => {
    assert.doesNotMatch(skill(name), /--(add|remove)-label\s+"?agent:/);
  });
}

test('pr-review: ai:in-progress знімається після ai:reviewed і на шляху без прав на лейбл', () => {
  const s = skill('pr-review');
  const reviewed = s.indexOf('--add-label "ai:reviewed"');
  const removes = [...s.matchAll(/--remove-label ai:in-progress/g)].map(m => m.index);
  assert.ok(reviewed > 0 && removes.some(i => i > reviewed), 'зняття після ai:reviewed');
  const noRights = s.indexOf('якщо прав на створення немає');
  assert.ok(noRights > 0, 'є шлях без прав');
  assert.match(s.slice(noRights, s.indexOf('\n\n', noRights)), /`ai:in-progress`/, 'на шляху без прав теж знімає');
  // Посилання «як описано нижче» веде на крок, що справді існує.
  assert.match(s, /`ai:in-progress` став і знімай, як описано нижче/);
  assert.match(s, /^## Крок 0в\. Познач початок роботи/m);
});

test('merge: ai:in-progress знімається на гейті, після gh pr merge до gh issue close і на помилці мерджу', () => {
  const s = skill('merge');
  const gate = s.indexOf('**зупинись без дій**');
  const gateLine = s.slice(s.lastIndexOf('\n', gate), s.indexOf('\n', gate));
  assert.match(gateLine, /зніми `ai:in-progress` з PR/);
  const merge = s.indexOf('gh pr merge $PR');
  const close = s.indexOf('gh issue close');
  const remove = s.indexOf('--remove-label ai:in-progress', merge);
  assert.ok(merge > 0 && remove > merge && close > remove, 'gh pr merge → зняття → gh issue close');
  const fail = s.indexOf('`gh pr merge` впав');
  assert.ok(fail > merge && fail < close, 'є шлях помилки мерджу');
  const failPara = s.slice(fail, s.indexOf('\n\n', fail));
  assert.match(failPara, /коментар/);
  assert.match(failPara, /`ai:in-progress`/);
  assert.match(failPara, /Виконай крок «Відпустити задачу в Kando»/);
});

test('плагін: версія 1.1.5', () => {
  const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(p.version, '1.1.5');
});

// PR лише з документацією: повна сюїта цих змін не перевіряє, а на великому проєкті займає
// раннер на десятки хвилин. Достатньо тестів, що читають змінені файли.
test('pr-review: PR лише з документацією — прицільні тести замість усієї сюїти', () => {
  const s = skill('pr-review');
  const evidence = s.slice(s.indexOf('**Докази**'), s.indexOf('**Регресії**'));
  const rule = evidence.split(/\n(?=- )/).map(b => b.replace(/\s+/g, ' ')).find(b => /лише документацію/.test(b));
  assert.ok(rule, 'у «Доказах» є пункт про PR лише з документацією');
  assert.match(rule, /усю сюїту не запускай/);
  assert.match(rule, /grep -rl/, 'шукає тести, що читають змінені файли');
  assert.match(rule, /прожени лише їх/);
  assert.match(rule, /«тести не запускались: лише документація»/);
  assert.match(rule, /не зауваження й не привід для ⚠️/);
  // Будь-який інший файл повертає звичайну перевірку.
  assert.match(rule, /Хоч один інший файл/);
  assert.match(rule, /сюїта як завжди/);
  // Проєкт може вимагати повну сюїту завжди: тоді діє його правило.
  assert.match(rule, /`CLAUDE\.md` \/ `AGENTS\.md` прямо вимагають/);
  // Шаблон рев'ю показує, як записати такий доказ.
  const template = s.slice(s.indexOf("## 🤖 Код-рев'ю"), s.indexOf('### Зауваження'));
  assert.match(template, /тести не запускались: лише документація/);
});

// Рев'ю #36: тека `docs/` сама по собі не робить файл документацією — код і конфіг сайту
// документації (`docs/conf.py`, `docs/package.json`) повертають повну сюїту.
test('pr-review: код і конфіг у `docs/` не вважаються документацією', () => {
  const s = skill('pr-review');
  const evidence = s.slice(s.indexOf('**Докази**'), s.indexOf('**Регресії**'));
  const rule = evidence.split(/\n(?=- )/).map(b => b.replace(/\s+/g, ' ')).find(b => /лише документацію/.test(b));
  assert.ok(rule);
  assert.doesNotMatch(rule, /теку `docs\/`/, 'уся тека docs/ не є документацією');
  assert.match(rule, /зокрема в `docs\/`/);
  assert.match(rule, /код чи конфіг у `docs\/`/);
});

// Рев'ю #36: «Обовʼязковий мінімум доказів» у Додатку не має суперечити винятку для docs-only PR.
test('pr-review: Додаток посилається на виняток для PR лише з документацією', () => {
  const s = skill('pr-review');
  const appendix = s.slice(s.indexOf('# Додаток: докази і GitHub'));
  const minimum = appendix.split(/\n(?=- )/).map(b => b.replace(/\s+/g, ' ')).find(b => /Обовʼязковий мінімум доказів/.test(b));
  assert.ok(minimum);
  assert.match(minimum, /лише документацію/);
  assert.match(minimum, /у «Доказах»/);
});

test('pr-review: машинний блок kando:review — дослівний формат перед підписом', () => {
  const s = skill('pr-review');
  assert.ok(s.includes('<!-- kando:review {"v":1,"round":<N>,"head":"<sha>","findings":[{"id":"R1","severity":"blocking","path":"src/app.js","line":142,"title":"…"}]} -->'));
  assert.match(s, /`severity` — `blocking` або `minor`/);
  assert.match(s, /`--` заміни на `—`/);
  assert.match(s, /`"` і `\\`/);
  const block = s.indexOf('<!-- kando:review');
  assert.ok(block > 0 && block < s.indexOf('<sub>🤖 Автоматичне рев\'ю'), 'блок перед підписом');
});
test('pr-review: id зауважень наскрізні, повторне — зі старим id', () => {
  const s = skill('pr-review');
  assert.match(s, /після найбільшого `R`/);
  assert.match(s, /зберігає свій `id`/);
  assert.match(s, /\*\*R1 · `src\/app\.js:142` — блокуюче\.\*\*/);
});
test('pr-review: повторне коло — лише перевірка виправлень і нові blocking у зміненому', () => {
  const s = skill('pr-review');
  assert.ok(s.includes('- Автоцикл: коло <N> з <M>'));
  const start = s.indexOf('### Повторне коло автоциклу');
  const rest = s.slice(start + 3);
  const sec = s.slice(start, start + 3 + rest.search(/\n#{2,3} /));
  assert.match(sec, /`N ≥ 2`/);
  assert.match(sec, /лише з `R`/);
  assert.match(sec, /`H`, `CI`, `CONFLICT`[^\n]*`pr-fix`[^\n]*не `findings`/);
  assert.match(sec, /git diff <попередній head>\.\.HEAD/);
  assert.match(sec, /Немає блоку `kando:triage` — перевіряй як перше коло/);
  assert.match(sec, /`human`[^\n]*не піднімай/);
  assert.match(sec, /зберігає стару `severity`/);
  assert.match(sec, /kando:triage/);
  assert.match(sec, /нових `minor` не додавай/);
  assert.match(sec, /`skip`[^\n]*не піднімай/);
});
test('pr-review: без рядка автоциклу round = 1, решта як раніше', () => {
  const s = skill('pr-review');
  assert.match(s, /без нього `round` = 1/);
});
