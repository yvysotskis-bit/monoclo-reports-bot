// Node-раннер: виконує весь src/ (включно з src/tests) в одному vm-контексті,
// так само, як Apps Script виконує глобальні файли, і викликає runTests().
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function listJs(dir) {
  let out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out = out.concat(listJs(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const ctx = vm.createContext({ console });
for (const file of listJs(path.join(__dirname, '..', 'src'))) {
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(ctx);
}
const res = vm.runInContext('runTests()', ctx);
process.exit(res.failed === 0 ? 0 : 1);
