import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sourceIdentity } from './source-identity.mjs';
import { sha256File } from '../src/release-manifest.mjs';

const root = path.resolve(import.meta.dirname, '..');
const before = await sourceIdentity(root);
const child = spawn(process.execPath, ['scripts/native.mjs', 'build', '--no-bundle'], { cwd: root, stdio: 'inherit', windowsHide: true });
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1)); });
if (code !== 0) process.exit(code);
const after = await sourceIdentity(root);
if (before.sha256 !== after.sha256 || before.commit !== after.commit) throw new Error('构建期间源码改变，拒绝暂存；请重新运行 npm run package');
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const sha256 = await sha256File(path.join(root, 'src-tauri/target/release/pi-desktop.exe'));
await writeFile(path.join(root, 'artifacts/package-source.json'), JSON.stringify({ source: after, sha256 }, null, 2) + '\n');
await import('./stage-native.mjs');
