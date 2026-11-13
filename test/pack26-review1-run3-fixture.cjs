const fs = require('node:fs'), path = require('node:path');
const [kind, base, folder] = process.argv.slice(2);
if (kind !== 'edit-after-add') throw new Error('Unknown owned Run3 fixture mode');
const held = path.join(base, 'native-run3-held.json');
fs.writeFileSync(held, JSON.stringify({ pid: process.pid }));
const until = Date.now() + 10000;
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(base, 'native-run3-release')) && Date.now() < until) return;
  clearInterval(timer);
  const file = path.join(folder, 'owned.txt'), old = fs.statSync(file);
  fs.writeFileSync(file, 'AFTER!'); fs.utimesSync(file, old.atime, old.mtime);
}, 10);
