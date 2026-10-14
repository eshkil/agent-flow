// Виходи кроку для action.yml: багаторядкові значення — через heredoc-розділювач,
// як вимагає GITHUB_OUTPUT.

const fs = require('node:fs');
const crypto = require('node:crypto');

function fileOutput(file) {
  return (key, value) => {
    const delim = `EOF_${crypto.randomUUID()}`;
    fs.appendFileSync(file, `${key}<<${delim}\n${value}\n${delim}\n`);
  };
}

module.exports = { fileOutput };
