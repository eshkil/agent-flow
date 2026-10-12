// Вибір кроку агента за станом задачі й сигналом людини. Чиста функція:
// усе потрібне приходить у state (його збирає gather.js), тож таблицю
// переходів зі специфікації можна перевірити без мережі.

const has = (labels, name) => labels.includes(name);

// Порядок перевірок — як match_order колонок Kando: перший збіг виграє.
function stageOf(s) {
  const pr = s.pr;
  if (s.closed || pr?.state === 'merged') return 'done';
  if (pr?.state === 'open') return has(pr.labels, 'ai:reviewed') ? 'review_done' : 'review';
  if (has(s.labels, 'spec:approved')) return 'spec_approved';
  if (has(s.labels, 'spec:ready')) return 'spec_review';
  if (has(s.labels, 'ai:triaged')) return 'triaged';
  return 'new';
}

// Що бракує для мерджу. Approve рахується лише на поточному head і лише від
// людини з allow-list: схвалення старого коміту — схвалення іншого коду.
function mergeGate(pr, allowedUsers) {
  const missing = [];
  if (!has(pr.labels, 'ai:reviewed')) {
    missing.push('немає `ai:reviewed` — спершу AI-рев\'ю');
  } else if (pr.lastPushAt && (!pr.reviewedLabelAt || pr.reviewedLabelAt < pr.lastPushAt)) {
    missing.push('після AI-рев\'ю були нові коміти — потрібне повторне рев\'ю');
  }
  const approved = pr.approvals.some(a => a.commitId === pr.headSha && allowedUsers.includes(a.login));
  if (!approved) missing.push('немає Approve від людини на поточному коміті');
  if (pr.checks === 'failure') missing.push('перевірки CI червоні');
  if (pr.checks === 'pending') missing.push('перевірки CI ще йдуть');
  if (pr.draft) missing.push('PR у статусі draft');
  if (pr.mergeable === 'CONFLICTING') missing.push('є конфлікти з базовою гілкою');
  return missing;
}

const NO_FEEDBACK = 'Що саме переробити? Напиши коментар із зауваженнями і постав `agent:rework` знову.';

function route(s, trigger, { allowedUsers }) {
  const stage = stageOf(s);
  const issue = s.kind === 'issue' ? s.number : null;
  const pr = s.pr?.number ?? null;
  const run = (skill, mode = trigger === 'rework' ? 'rework' : 'first') =>
    ({ action: 'run', stage, skill, mode, issue, pr });
  const refuse = reason => ({ action: 'refuse', stage, reason });

  if (stage === 'done') return { action: 'ignore', stage };
  // Нова задача ще не має результату агента — переробляти нема чого, це той самий тріаж.
  if (stage === 'new') return run('triage', 'first');
  if (trigger === 'rework' && !s.humanFeedback) return refuse(NO_FEEDBACK);

  switch (stage) {
    case 'triaged':
      if (trigger === 'rework') return run('triage');
      if (s.openQuestions) {
        return refuse('У тріажі лишилися питання («❓ Потрібно уточнити»). Дай відповідь коментарем і постав `agent:rework`.');
      }
      if (has(s.labels, 'type:feature')) return run('feature-spec');
      if (has(s.labels, 'type:bug')) return run('bug-agent');
      return refuse('Тип задачі не фіча й не баг — агентові тут нема що робити. Зміни тип лейблом `type:feature` / `type:bug`, якщо це помилка тріажу.');
    case 'spec_review':
      if (trigger === 'rework') return run('feature-spec');
      return refuse('Спеку схвалює людина: перетягни картку в «Спеку схвалено» або постав `spec:approved`. Переписати — коментар + `agent:rework`.');
    case 'spec_approved':
      return trigger === 'rework' ? run('feature-spec') : run('implement');
    case 'review':
      return trigger === 'rework' ? run('pr-fix') : run('pr-review');
    case 'review_done': {
      if (trigger === 'rework') return run('pr-fix');
      const missing = mergeGate(s.pr, allowedUsers);
      if (missing.length) return refuse(`Мерджити ще не можна:\n${missing.map(m => `- ${m}`).join('\n')}`);
      return run('merge');
    }
    default:
      return refuse(`Невідомий етап: ${stage}`);
  }
}

module.exports = { stageOf, mergeGate, route };
