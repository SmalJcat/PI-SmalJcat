import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { holdSessionLease } from './tauri-harness.mjs';

// These tests exercise the process protocol without pretending to acquire a
// native lease. test:session-lease separately verifies Rust OS-level contention.
test('lease harness waits for readiness and releases by closing stdin', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-lease-harness-'));
  try {
    const script = path.join(temp, 'helper.cjs');
    const marker = path.join(temp, 'released.txt');
    await writeFile(script, `
      const fs = require('node:fs');
      process.stdin.resume();
      process.stdin.on('end', () => fs.writeFileSync(process.argv[2], 'released'));
      setTimeout(() => console.log('session-lease-ready'), 25);
    `);
    const release = await holdSessionLease(process.execPath, script, marker);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await release();
    assert.equal(await readFile(marker, 'utf8'), 'released');
    await release(); // Cleanup is safe when repeated.
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('lease harness reports early helper failure instead of UI timeout', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-lease-harness-'));
  try {
    const script = path.join(temp, 'failure.cjs');
    await writeFile(script, "console.error('test session lease unavailable'); process.exit(1);\n");
    await assert.rejects(holdSessionLease(process.execPath, script, 'unused'), /test session lease unavailable/);
    await assert.rejects(holdSessionLease(path.join(temp, 'missing-helper'), temp, 'unused'), /ENOENT/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
