const { test } = require('node:test');
const assert = require('node:assert');
const { buildPrompt } = require('../src/prompt');

const base = {
  repo: 'eshkil/kando-board', sender: 'eshkil', trigger: 'go',
  signalAt: '2026-10-10T10:00:00Z', runUrl: 'https://github.com/eshkil/kando-board/actions/runs/1',
};

test('промпт називає скіл плагіна, репо, номер і явну команду людини', () => {
  const p = buildPrompt({ ...base, decision: { skill: 'triage', mode: 'first', issue: 12, pr: null } });
  assert.match(p, /agent-flow:triage/);
  assert.match(p, /eshkil\/kando-board/);
  assert.match(p, /ISSUE=12/);
  assert.match(p, /Контекст запуску \(диспетчер agent-flow\)/);
  assert.match(p, /@eshkil/);
  assert.doesNotMatch(p, /PR=/);
});

test('етап ревʼю: передається номер PR', () => {
  const p = buildPrompt({ ...base, decision: { skill: 'pr-review', mode: 'first', issue: 12, pr: 40 } });
  assert.match(p, /PR=40/);
  assert.match(p, /ISSUE=12/);
});

test('режим rework описано явно', () => {
  const p = buildPrompt({ ...base, trigger: 'rework', decision: { skill: 'feature-spec', mode: 'rework', issue: 12, pr: null } });
  assert.match(p, /Режим: rework/);
  assert.match(p, /Що змінилося/);
});

test('промпт попереджає про неінтерактивний запуск: без фонових агентів і очікувань', () => {
  const p = buildPrompt({ ...base, decision: { skill: 'implement', mode: 'first', issue: 12, pr: null } });
  assert.match(p, /неінтерактивн/);
  assert.match(p, /run_in_background/);
  assert.match(p, /ScheduleWakeup/);
  assert.match(p, /запуш/);
});

test('доробка після мерджу: новий PR від базової гілки, у змерджений не пушити', () => {
  const p = buildPrompt({ ...base, trigger: 'rework', decision: { skill: 'implement', mode: 'rework', issue: 12, pr: null, mergedPr: 109 } });
  assert.doesNotMatch(p, /PR=/);
  assert.match(p, /перевідкрито після мерджу PR #109/);
  assert.match(p, /новий PR/);
});

test('без змердженого PR промпт не згадує доробку після мерджу', () => {
  const p = buildPrompt({ ...base, decision: { skill: 'implement', mode: 'first', issue: 12, pr: null } });
  assert.doesNotMatch(p, /після мерджу/);
});
