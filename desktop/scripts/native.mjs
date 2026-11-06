import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
const env = { ...process.env, PATH: `${cargoBin}${path.delimiter}${process.env.PATH || ''}` };
const mode = process.argv[2];
let executable, args;
if (mode === 'cargo') {
  executable = existsSync(path.join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo')) ? path.join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo') : 'cargo';
  args = process.argv.slice(3);
} else if (mode === 'start') {
  executable = path.join(root, 'release', 'tauri', process.platform === 'win32' ? 'Pi Desktop.exe' : 'pi-desktop');
  if (!existsSync(executable)) { console.error('请先运行 npm run package。'); process.exit(1); }
  args = [];
} else {
  executable = process.execPath;
  args = [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...process.argv.slice(2)];
}
const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', shell: false });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
