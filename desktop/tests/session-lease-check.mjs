import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { holdSessionLease } from './tauri-harness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const executable = path.join(root, `src-tauri/target/debug/pi-session-lease${process.platform === 'win32' ? '.exe' : ''}`);
const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-lease-check-'));
const locks = path.join(temp, 'locks');
const session = path.join(temp, '会话.jsonl');
await writeFile(session, 'original session bytes\n');
let release;
try {
  release = await holdSessionLease(executable, locks, session);
  await assert.rejects(holdSessionLease(executable, locks, session), /test session lease unavailable/);
  await release(); release = undefined;
  release = await holdSessionLease(executable, locks, session);
  await release(); release = undefined;
  assert.equal(await readFile(session, 'utf8'), 'original session bytes\n');
  await assert.rejects(holdSessionLease(path.join(temp, 'missing-executable'), locks, session), /ENOENT/);
  console.log('Session lease checks passed: real contention, release/reacquire, unchanged session, spawn failure.');
} finally {
  if (release) await release();
  await rm(temp, { recursive: true, force: true });
}
