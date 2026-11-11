import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sourceIdentity } from './source-identity.mjs';
import { deployRelease } from './release-files.mjs';
const root = path.resolve(import.meta.dirname, '..');
const destination = path.join(root, 'release/tauri');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tauri = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const cargo = await readFile(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
assert.equal(tauri.version, version, 'Tauri and package versions must match');
assert.equal(/^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1], version, 'Cargo and package versions must match');
const source = path.join(root, 'src-tauri/target/release/pi-desktop.exe');
const executable = path.join(destination, 'Pi Desktop.exe');
const manifest = path.join(destination, 'release.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = await readFile(source);
const sha256 = digest(sourceBytes);
const receipt = JSON.parse(await readFile(path.join(root, 'artifacts/package-source.json'), 'utf8'));
const identity = receipt.source;
assert.equal(sha256, receipt.sha256, 'Executable changed since packaging; run npm run package again');
assert.deepEqual(await sourceIdentity(root), identity, 'Source changed since packaging; run npm run package again');
const parent = path.dirname(destination);
await mkdir(parent, { recursive: true });
const staged = await mkdtemp(path.join(parent, '.package-'));
try {
  await copyFile(source, path.join(staged, 'Pi Desktop.exe'));
  await copyFile(path.join(root, 'src-tauri/icons/icon.ico'), path.join(staged, 'icon.ico'));
  await writeFile(path.join(staged, 'release.json'), JSON.stringify({ version, runtime: 'tauri', executable: 'Pi Desktop.exe', bytes: sourceBytes.length, sha256, stagedAt: new Date().toISOString(), source: identity }, null, 2) + '\n');
  const result = await deployRelease(staged, destination);
  if (result.backup) console.log(`Previous release: ${result.backup}`);
} finally {
  if (path.dirname(staged) === parent && path.basename(staged).startsWith('.package-')) await rm(staged, { recursive: true, force: true });
}
console.log(`Tauri executable: ${executable}\nVersion: ${version}\nSHA-256: ${sha256}\nManifest: ${manifest}`);
