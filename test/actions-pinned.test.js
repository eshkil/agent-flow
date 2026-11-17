// Сторонні дії в шаблонах і раннері закріплено за SHA коміту: тег автор може
// переписати, і в репо користувача пішов би інший код. Власні eshkil/agent-flow — за тегом.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['templates/kando-agent.yml', 'templates/agent.yml', 'runner/action.yml', 'action.yml', '.github/workflows/kando-agent.yml'];

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
