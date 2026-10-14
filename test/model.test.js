const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pickModel, SKILLS } = require('../src/model');

test('model: порожня специфікація → без моделі (дефолт Claude Code)', () => {
  assert.equal(pickModel('', 'implement'), '');
  assert.equal(pickModel(undefined, 'implement'), '');
  assert.equal(pickModel('  ', 'implement'), '');
});

test('model: одна модель — для всіх скілів (як було)', () => {
  assert.equal(pickModel('claude-opus-5-5', 'triage'), 'claude-opus-5-5');
  assert.equal(pickModel(' opus ', 'implement'), 'opus');
});

test('model: скіл=модель перевизначає дефолт лише для свого скіла', () => {
  const spec = 'claude-opus-5-5, triage=claude-sonnet-5-5, pr-review=claude-sonnet-5-5';
  assert.equal(pickModel(spec, 'triage'), 'claude-sonnet-5-5');
  assert.equal(pickModel(spec, 'pr-review'), 'claude-sonnet-5-5');
  assert.equal(pickModel(spec, 'implement'), 'claude-opus-5-5');
});

test('model: лише перевизначення без дефолту → решта скілів на дефолті Claude Code', () => {
  assert.equal(pickModel('implement=opus', 'implement'), 'opus');
  assert.equal(pickModel('implement=opus', 'triage'), '');
});

test('model: розділювачі — кома, крапка з комою, пробіли й переноси рядків', () => {
  const spec = 'opus;triage=sonnet\n  pr-review = haiku ,  bug-agent=opus';
  assert.equal(pickModel(spec, 'triage'), 'sonnet');
  assert.equal(pickModel(spec, 'pr-review'), 'haiku');
  assert.equal(pickModel(spec, 'bug-agent'), 'opus');
  assert.equal(pickModel(spec, 'merge'), 'opus');
});

test('model: невідомий скіл у мапі — помилка з переліком скілів (одруківка не має тихо ігноруватись)', () => {
  assert.throws(() => pickModel('opus, pr_review=sonnet', 'implement'), /pr_review.*pr-review/s);
});

test('model: дві моделі за замовчуванням або два записи для скіла — помилка', () => {
  assert.throws(() => pickModel('opus sonnet', 'implement'), /за замовчуванням/);
  assert.throws(() => pickModel('triage=opus, triage=sonnet', 'triage'), /triage/);
});

test('model: порожня модель у записі — помилка', () => {
  assert.throws(() => pickModel('triage=', 'triage'), /triage/);
});

test('model: перелік SKILLS збігається зі скілами плагіна', () => {
  const dir = path.join(__dirname, '..', 'plugin', 'skills');
  const onDisk = fs.readdirSync(dir).filter(d => fs.statSync(path.join(dir, d)).isDirectory()).sort();
  assert.deepEqual([...SKILLS].sort(), onDisk);
});
