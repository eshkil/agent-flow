// Сторонні дії в шаблонах і раннері закріплено за SHA коміту: тег автор може
// переписати, і в репо користувача пішов би інший код. Власні eshkil/agent-flow — за тегом.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['templates/kando-agent.yml', 'runner/action.yml', '.github/workflows/kando-agent.yml'];

for (const file of FILES) {
  test(`${file}: сторонні дії закріплено за SHA`, () => {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map(m => m[1]);
    assert.ok(uses.length > 0);
    for (const ref of uses) {
      if (ref.startsWith('eshkil/agent-flow')) continue;
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${ref} не закріплено за SHA`);
    }
  });
}

// Dependabot оновлює лише .github/workflows і runner/action.yml; шаблони він не бачить.
// Після його PR ці тести падають, поки шаблони не оновлять так само.
test('templates/kando-agent.yml збігається з .github/workflows/kando-agent.yml (без першого рядка)', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const own = read('.github/workflows/kando-agent.yml').split('\n').slice(1).join('\n');
  assert.equal(read('templates/kando-agent.yml'), own);
});

test('та сама стороння дія скрізь закріплена за тим самим SHA', () => {
  const seen = new Map();
  for (const file of FILES) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const [, action, sha] of text.matchAll(/^\s*(?:- )?uses: ([^@\s]+)@([0-9a-f]{40})/gm)) {
      const first = seen.get(action);
      if (first) assert.equal(sha, first.sha, `${action}: ${file} має ${sha}, а ${first.file} — ${first.sha}`);
      else seen.set(action, { sha, file });
    }
  }
});
