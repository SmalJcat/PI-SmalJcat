import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { deployRelease, readRelease } from '../scripts/release-files.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  for (const [dir, version, bytes] of [[source, '0.5.0', 'new exe'], [target, '0.4.1', 'old exe']]) {
    await mkdir(dir);
    await writeFile(path.join(dir, 'Pi Desktop.exe'), bytes);
    await writeFile(path.join(dir, 'release.json'), JSON.stringify({ version, runtime: 'tauri', executable: 'Pi Desktop.exe', bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }));
  }
  return { root, source, target };
}

test('deployment verifies new bytes, preserves old release and supports explicit rollback', async t => {
  const { source, target } = await fixture(t);
  const result = await deployRelease(source, target);
  assert.equal((await readRelease(target)).version, '0.5.0');
  assert.equal((await readRelease(result.backup)).version, '0.4.1');
  const restored = await deployRelease(result.backup, target);
  assert.equal((await readRelease(target)).version, '0.4.1');
  assert.equal((await readRelease(restored.backup)).version, '0.5.0');
});

test('corrupt source cannot overwrite the installed release', async t => {
  const { root, source, target } = await fixture(t);
  await writeFile(path.join(source, 'Pi Desktop.exe'), 'damaged');
  await assert.rejects(deployRelease(source, target), /SHA-256/);
  assert.equal((await readRelease(target)).version, '0.4.1');
  assert.deepEqual((await readdir(root)).sort(), ['source', 'target']);
});

test('failed directory switch restores the old release and removes scratch state', async t => {
  const { root, source, target } = await fixture(t);
  let calls = 0;
  await assert.rejects(deployRelease(source, target, { move: async (...args) => {
    if (++calls === 2) throw new Error('simulated locked destination');
    return rename(...args);
  } }), /locked destination/);
  assert.equal(calls, 3);
  assert.equal((await readRelease(target)).version, '0.4.1');
  assert.deepEqual((await readdir(root)).sort(), ['source', 'target']);
});

test('source private files are not copied and unknown destination data blocks deployment', async t => {
  const { source, target } = await fixture(t);
  await writeFile(path.join(source, 'keys.json'), 'do not distribute');
  await deployRelease(source, target);
  assert.deepEqual((await readdir(target)).sort(), ['Pi Desktop.exe', 'release.json']);
  await writeFile(path.join(target, 'preferences.json'), 'user data');
  await assert.rejects(deployRelease(source, target), /非发布文件/);
  assert.equal(await readFile(path.join(target, 'preferences.json'), 'utf8'), 'user data');
});

test('overlapping paths and concurrent deployments are rejected', async t => {
  const { source, target } = await fixture(t);
  await assert.rejects(deployRelease(source, source), /互相包含/);
  await assert.rejects(deployRelease(source, path.join(source, 'child')), /互相包含/);
  await mkdir(`${target}.deploy-lock`);
  await assert.rejects(deployRelease(source, target), { code: 'EEXIST' });
  assert.equal((await readRelease(target)).version, '0.4.1');
});
