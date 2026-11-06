import { copyFile, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const destination = path.join(root, 'release/tauri');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tauri = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const cargo = await readFile(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
assert.equal(tauri.version, version, 'Tauri and package versions must match');
assert.equal(/^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1], version, 'Cargo and package versions must match');
const source = path.join(root, 'src-tauri/target/release/pi-desktop.exe');
const executable = path.join(destination, 'Pi Desktop.exe');
const staged = path.join(destination, `.pi-desktop-${process.pid}.tmp`);
const manifest = path.join(destination, 'release.json');
const stagedManifest = path.join(destination, `.release-${process.pid}.tmp`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = await readFile(source);
const sha256 = digest(sourceBytes);
await mkdir(destination, { recursive: true });
try {
  await copyFile(source, staged);
  assert.equal(digest(await readFile(staged)), sha256, 'Staged executable must match the build');
  await copyFile(path.join(root, 'src-tauri/icons/icon.ico'), path.join(destination, 'icon.ico'));
  await writeFile(stagedManifest, JSON.stringify({ version, runtime: 'tauri', executable: 'Pi Desktop.exe', bytes: sourceBytes.length, sha256, stagedAt: new Date().toISOString() }, null, 2) + '\n');
  await rename(staged, executable);
  await rename(stagedManifest, manifest);
} finally {
  await rm(staged, { force: true });
  await rm(stagedManifest, { force: true });
}
console.log(`Tauri executable: ${executable}\nVersion: ${version}\nSHA-256: ${sha256}\nManifest: ${manifest}`);
