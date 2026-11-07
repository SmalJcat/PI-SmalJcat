import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const repository = path.dirname(root);
const mode = process.argv[2];
if (!['cloud', 'windows'].includes(mode) || !process.env.npm_execpath) {
  throw new Error('请运行 npm run check:cloud 或 npm run check:windows。');
}
if (mode === 'windows' && process.platform !== 'win32') {
  throw new Error('Windows 验收必须在 Windows / WebView2 独立副本中运行。');
}
const directory = path.join(root, 'artifacts', 'verification', mode);
mkdirSync(directory, { recursive: true });
const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
// Git clean filters normalize checkout line endings, so Windows and Linux agree.
const sourceSnapshot = () => {
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  return Object.fromEntries(files.map(file => [file, existsSync(path.join(repository, file)) ? git(['hash-object', `--path=${file}`, file]) : null]));
};
const sources = sourceSnapshot();
const report = {
  success: false, mode, platform: process.platform, node: process.version,
  version: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  commit: git(['rev-parse', 'HEAD']), changes: git(['status', '--porcelain']),
  sourceDigest: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
  startedAt: new Date().toISOString(), checks: [],
};
writeFileSync(path.join(directory, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
const save = () => writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
save();
const node = process.execPath;
const npm = (...args) => [node, process.env.npm_execpath, ...args];
const cargo = (...args) => [node, 'scripts/native.mjs', 'cargo', ...args];
const manifest = ['--manifest-path', 'src-tauri/Cargo.toml'];
const checks = [
  ['build', npm('run', 'build')],
  ['javascript', npm('test')],
  ['rust', cargo('test', ...manifest, '--locked', '--no-default-features')],
  ['session-lease', npm('run', 'test:session-lease')],
  ['format', cargo('fmt', ...manifest, '--', '--check')],
  ['clippy', cargo('clippy', ...manifest, '--locked', ...(mode === 'cloud' ? ['--no-default-features'] : []), '--all-targets', '--features', 'test-fixture', '--', '-D', 'warnings')],
  ...(mode === 'windows' ? [['webview2', npm('run', 'test:ui')]] : []),
];
for (const [name, [command, ...args]] of checks) {
  console.log(`\nRunning ${name}`);
  const log = createWriteStream(path.join(directory, `${name}.log`));
  const started = Date.now();
  const result = await new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log.write(bytes); process.stdout.write(bytes); });
    let failure;
    child.on('error', error => { failure = error.message; log.write(failure + '\n'); });
    child.on('close', code => log.end(() => resolve({ name, exitCode: code, ...(failure ? { error: failure } : {}), durationMs: Date.now() - started })));
  });
  report.checks.push(result);
  save();
  if (result.exitCode !== 0 || result.error) {
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=${name} verification failed::See artifacts/verification/${mode}/${name}.log for diagnostics.`);
    process.exitCode = 1; break;
  }
}
report.sourceUnchanged = JSON.stringify(sourceSnapshot()) === JSON.stringify(sources);
if (!report.sourceUnchanged) { report.error = 'Source files changed during verification; rerun on an unchanged checkout.'; process.exitCode = 1; }
report.success = report.sourceUnchanged && report.checks.length === checks.length && report.checks.every(check => check.exitCode === 0 && !check.error);
report.finishedAt = new Date().toISOString();
save();
console.log(`Verification ${report.success ? 'passed' : 'failed'}: ${path.join(directory, 'result.json')}`);
