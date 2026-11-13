const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] === 'native-hook') {
  const { spawn } = require('node:child_process');
  const base = process.argv[3];
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', windowsHide: true });
  fs.writeFileSync(path.join(base, 'native-hook-pids.json'), JSON.stringify({ hook: process.pid, descendant: child.pid }));
  setInterval(() => {}, 1000);
} else {
const base = process.argv[2], args = process.argv.slice(3);
const optionsFile = path.join(base, 'git-process-options.json');
const options = () => { try { return JSON.parse(fs.readFileSync(optionsFile, 'utf8')); } catch { return {}; } };
const folder = args[args.indexOf('-C') + 1], command = args.slice(args.indexOf('-C') + 2);
const kind = command[0];
const stateFile = path.join(base, 'git-process-state.json');
let state = { commits: 0, subject: '' };
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
fs.appendFileSync(path.join(base, 'git-process-start.jsonl'), JSON.stringify({ pid: process.pid, args: command, at: Date.now() }) + '\n');
const finish = () => {
  const config = options();
  if (config.editAfterAdd && kind === 'add') {
    const file = path.join(folder, 'owned.txt'), old = fs.statSync(file);
    fs.writeFileSync(file, 'AFTER!'); fs.utimesSync(file, old.atime, old.mtime);
  }
  let out = '';
  if (kind === 'rev-parse') out = command[1] === '--is-inside-work-tree' ? 'true' : String.fromCharCode(97 + state.commits).repeat(40);
  if (kind === 'status') out = config.clean ? '' : ' M owned.txt\0';
  if (kind === 'commit') { state.commits++; state.subject = command[command.indexOf('-m') + 1]; fs.writeFileSync(stateFile, JSON.stringify(state)); out = 'committed'; }
  if (kind === 'diff-tree') out = config.unrelated ? 'unrelated.txt\0' : 'owned.txt\0';
  if (kind === 'log') out = state.subject;
  if (config.output && (!config.kind || config.kind === kind)) out = 'é'.repeat(config.output);
  process.stdout.write(out);
  process.exitCode = config.exit && (!config.kind || config.kind === kind) ? config.exit : 0;
};
const config = options();
if (config.hold === kind) {
  const releaseAt = Date.now() + (config.releaseMs ?? 1800);
  fs.writeFileSync(path.join(base, 'git-held'), String(process.pid));
  const interval = setInterval(() => {
    if (Date.now() < releaseAt && !fs.existsSync(path.join(base, 'git-release'))) return;
    clearInterval(interval); fs.writeFileSync(path.join(base, 'git-released'), String(Date.now())); finish();
  }, 10);
} else finish();
}
