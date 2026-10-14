const { test } = require('node:test');
const assert = require('node:assert');
const { stageOf, mergeGate, route } = require('../src/route');

const ALLOWED = ['eshkil'];
const issue = (labels = [], over = {}) => ({
  kind: 'issue', number: 12, closed: false, labels, pr: null,
  openQuestions: false, humanFeedback: false, ...over,
});
const openPr = (over = {}) => ({
  number: 40, state: 'open', labels: [], draft: false, mergeable: 'MERGEABLE',
  headSha: 'abc', lastPushAt: 1000, reviewedLabelAt: null, approvals: [], checks: 'success',
  ...over,
});
const readyPr = (over = {}) => openPr({
  labels: ['ai:reviewed'], reviewedLabelAt: 2000,
  approvals: [{ login: 'eshkil', commitId: 'abc' }], ...over,
});
const go = s => route(s, 'go', { allowedUsers: ALLOWED });
const rework = s => route(s, 'rework', { allowedUsers: ALLOWED });

test('stageOf: порядок визначення етапу', () => {
  assert.equal(stageOf(issue([], { closed: true })), 'done');
  // Відкритий issue зі змердженим PR — перевідкрито після мерджу, не «готово».
  assert.equal(stageOf(issue([], { pr: openPr({ state: 'merged' }) })), 'reopened');
  assert.equal(stageOf(issue([], { closed: true, pr: openPr({ state: 'merged' }) })), 'done');
  assert.equal(stageOf(issue(['spec:approved'], { pr: openPr({ labels: ['ai:reviewed'] }) })), 'review_done');
  assert.equal(stageOf(issue(['spec:approved'], { pr: openPr() })), 'review');
  assert.equal(stageOf(issue(['ai:triaged', 'spec:ready', 'spec:approved'])), 'spec_approved');
  assert.equal(stageOf(issue(['ai:triaged', 'spec:ready'])), 'spec_review');
  assert.equal(stageOf(issue(['ai:triaged'])), 'triaged');
  assert.equal(stageOf(issue([])), 'new');
  assert.equal(stageOf(issue(['ai:triaged'], { pr: openPr({ state: 'closed' }) })), 'triaged');
});

test('Нові: go і rework → triage', () => {
  assert.deepEqual(go(issue()), { action: 'run', stage: 'new', skill: 'triage', mode: 'first', issue: 12, pr: null });
  assert.equal(rework(issue()).skill, 'triage');
});

test('Розглянуто: фіча → feature-spec, баг → bug-agent', () => {
  assert.equal(go(issue(['ai:triaged', 'type:feature'])).skill, 'feature-spec');
  assert.equal(go(issue(['ai:triaged', 'type:bug'])).skill, 'bug-agent');
});

test('Розглянуто: інший тип → відмова', () => {
  const r = go(issue(['ai:triaged', 'type:other']));
  assert.equal(r.action, 'refuse');
  assert.match(r.reason, /тип/);
});

test('Розглянуто: відкриті питання → відмова з підказкою про agent:rework', () => {
  const r = go(issue(['ai:triaged', 'type:feature'], { openQuestions: true }));
  assert.equal(r.action, 'refuse');
  assert.match(r.reason, /agent:rework/);
});

test('Розглянуто: rework з відгуком → triage у режимі rework', () => {
  const r = rework(issue(['ai:triaged', 'type:feature'], { humanFeedback: true }));
  assert.equal(r.skill, 'triage');
  assert.equal(r.mode, 'rework');
});

test('rework без відгуку людини → відмова «що саме переробити?»', () => {
  for (const s of [issue(['ai:triaged']), issue(['ai:triaged', 'spec:ready']), issue(['spec:approved'], { pr: openPr() })]) {
    const r = rework(s);
    assert.equal(r.action, 'refuse');
    assert.match(r.reason, /Що саме переробити/);
  }
});

test('Спека на ревʼю: go → відмова зі способом схвалення; rework → feature-spec', () => {
  const r = go(issue(['ai:triaged', 'spec:ready']));
  assert.equal(r.action, 'refuse');
  assert.match(r.reason, /Спеку схвалено/);
  assert.equal(rework(issue(['ai:triaged', 'spec:ready'], { humanFeedback: true })).skill, 'feature-spec');
});

test('Спеку схвалено: go → implement; rework → feature-spec', () => {
  assert.equal(go(issue(['spec:ready', 'spec:approved'])).skill, 'implement');
  assert.equal(rework(issue(['spec:ready', 'spec:approved'], { humanFeedback: true })).skill, 'feature-spec');
});

test('На ревʼю: go → pr-review з номером PR; rework → pr-fix', () => {
  const r = go(issue(['spec:approved'], { pr: openPr() }));
  assert.deepEqual([r.skill, r.issue, r.pr], ['pr-review', 12, 40]);
  assert.equal(rework(issue(['spec:approved'], { pr: openPr(), humanFeedback: true })).skill, 'pr-fix');
});

test('сигнал на сам PR без issue: issue = null', () => {
  const pr = openPr();
  const r = go({ kind: 'pr', number: 40, closed: false, labels: [], pr, openQuestions: false, humanFeedback: false });
  assert.deepEqual([r.skill, r.issue, r.pr], ['pr-review', null, 40]);
});

test('Ревʼю зроблено: усе виконано → merge', () => {
  assert.equal(go(issue(['spec:approved'], { pr: readyPr() })).skill, 'merge');
});

test('Ревʼю зроблено: rework → pr-fix', () => {
  assert.equal(rework(issue([], { pr: readyPr(), humanFeedback: true })).skill, 'pr-fix');
});

test('Готово: відмова з поясненням, як доопрацювати', () => {
  const r = go(issue([], { closed: true }));
  assert.equal(r.action, 'refuse');
  assert.match(r.reason, /закрит/);
  assert.match(r.reason, /перевідкрий/);
});

const reopened = (labels, over = {}) =>
  issue(['ai:triaged', 'spec:ready', 'spec:approved', ...labels], { pr: openPr({ number: 109, state: 'merged' }), ...over });

test('Перевідкрито після мерджу: фіча → implement у режимі rework, новим PR', () => {
  const expected = { action: 'run', stage: 'reopened', skill: 'implement', mode: 'rework', issue: 12, pr: null, mergedPr: 109 };
  assert.deepEqual(rework(reopened(['type:feature'], { humanFeedback: true })), expected);
  assert.deepEqual(go(reopened(['type:feature'], { humanFeedback: true })), expected);
});

test('Перевідкрито після мерджу: баг → bug-agent у режимі rework', () => {
  const r = rework(issue(['ai:triaged', 'type:bug'], { pr: openPr({ number: 109, state: 'merged' }), humanFeedback: true }));
  assert.equal(r.skill, 'bug-agent');
  assert.equal(r.mode, 'rework');
  assert.equal(r.mergedPr, 109);
});

test('Перевідкрито після мерджу без зауважень → відмова з проханням описати, що не так', () => {
  for (const r of [go(reopened(['type:feature'])), rework(reopened(['type:feature']))]) {
    assert.equal(r.action, 'refuse');
    assert.match(r.reason, /#109/);
    assert.match(r.reason, /agent:rework/);
  }
});

test('Перевідкрито після мерджу: фіча без схваленої спеки → відмова', () => {
  const r = rework(issue(['ai:triaged', 'type:feature'], { pr: openPr({ number: 109, state: 'merged' }), humanFeedback: true }));
  assert.equal(r.action, 'refuse');
  assert.match(r.reason, /spec:approved/);
});

test('гейт: готовий PR — нічого не бракує', () => {
  assert.deepEqual(mergeGate(readyPr(), ALLOWED), []);
});

test('гейт: Approve на старому SHA', () => {
  const missing = mergeGate(readyPr({ approvals: [{ login: 'eshkil', commitId: 'old' }] }), ALLOWED);
  assert.ok(missing.some(m => /Approve/.test(m)), missing.join('; '));
});

test('гейт: Approve від людини поза allow-list не рахується', () => {
  const missing = mergeGate(readyPr({ approvals: [{ login: 'stranger', commitId: 'abc' }] }), ALLOWED);
  assert.ok(missing.some(m => /Approve/.test(m)));
});

test('гейт: пуш після ai:reviewed', () => {
  const missing = mergeGate(readyPr({ lastPushAt: 3000, reviewedLabelAt: 2000 }), ALLOWED);
  assert.ok(missing.some(m => /нові коміти/.test(m)));
});

test('гейт: червоні та незавершені checks, draft, конфлікти', () => {
  assert.ok(mergeGate(readyPr({ checks: 'failure' }), ALLOWED).some(m => /червоні/.test(m)));
  assert.ok(mergeGate(readyPr({ checks: 'pending' }), ALLOWED).some(m => /ще йдуть/.test(m)));
  assert.ok(mergeGate(readyPr({ draft: true }), ALLOWED).some(m => /draft/.test(m)));
  assert.ok(mergeGate(readyPr({ mergeable: 'CONFLICTING' }), ALLOWED).some(m => /конфлікти/.test(m)));
  assert.deepEqual(mergeGate(readyPr({ checks: 'none' }), ALLOWED), []);
});

test('Ревʼю зроблено без Approve → відмова з переліком', () => {
  const r = go(issue([], { pr: readyPr({ approvals: [] }) }));
  assert.equal(r.action, 'refuse');
  assert.match(r.reason, /Approve/);
});
