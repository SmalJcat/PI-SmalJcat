import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForCdp } from './tauri-harness.mjs';

function harness(overrides = {}) {
  let time = 0;
  const diagnostics = {};
  const logs = [];
  return {
    url: 'http://127.0.0.1:12345', diagnostics,
    processState: () => ({ pid: 123, exitCode: null, signalCode: null, stdout: '', stderr: '' }),
    timeout: 12000, attemptTimeout: 5000, retryDelay: 250,
    now: () => time, sleep: async ms => { time += ms; },
    log: message => logs.push(message), logs,
    advance: ms => { time += ms; },
    ...overrides,
  };
}

test('CDP retries preserve errors and permit a slow handshake', async () => {
  const options = harness();
  const browser = {};
  options.connect = async (_url, { timeout }) => {
    assert.equal(timeout, 5000);
    if (options.diagnostics.attempts === 1) throw new Error('ECONNREFUSED');
    options.advance(1500);
    return browser;
  };
  assert.equal(await waitForCdp(options), browser);
  assert.equal(options.diagnostics.attempts, 2);
  assert.equal(options.diagnostics.elapsedMs, 1750);
  assert.equal(options.diagnostics.connected, true);
  assert.match(options.diagnostics.firstError, /ECONNREFUSED/);
  assert.match(options.logs[0], /127.0.0.1:12345/);
});

test('CDP failure reports first and final errors within the overall deadline', async () => {
  const options = harness();
  const budgets = [];
  options.connect = async (_url, { timeout }) => {
    budgets.push(timeout);
    options.advance(timeout);
    throw new Error(`handshake ${budgets.length} failed`);
  };
  await assert.rejects(waitForCdp(options), /WebView2 CDP unavailable/);
  assert.deepEqual(budgets, [5000, 5000, 1500]);
  assert.equal(options.diagnostics.elapsedMs, 12000);
  assert.match(options.diagnostics.firstError, /handshake 1 failed/);
  assert.match(options.diagnostics.lastError, /handshake 3 failed/);
});

for (const state of [
  { exitCode: 1, stderr: 'runtime failed' },
  { signalCode: 'SIGTERM' },
  { spawnError: 'spawn ENOENT' },
]) {
  test(`CDP fails immediately on process failure: ${JSON.stringify(state)}`, async () => {
    const options = harness({
      processState: () => ({ exitCode: null, signalCode: null, ...state }),
      connect: () => assert.fail('must not connect after process failure'),
    });
    await assert.rejects(waitForCdp(options), /Tauri stopped before WebView2/);
    assert.equal(options.diagnostics.attempts, 0);
    assert.deepEqual(options.diagnostics.process, { exitCode: null, signalCode: null, ...state });
  });
}

test('CDP detects process exit between retries', async () => {
  let exited = false;
  const options = harness({
    processState: () => ({ exitCode: exited ? 2 : null, signalCode: null }),
    connect: async () => { exited = true; throw new Error('connection closed'); },
  });
  await assert.rejects(waitForCdp(options), /Tauri stopped before WebView2/);
  assert.equal(options.diagnostics.attempts, 1);
});

for (const ci of [true, false]) {
  test(`CDP default budget supports slow CI startup: CI=${ci}`, async () => {
    const previous = process.env.CI;
    try {
      if (ci) process.env.CI = 'true'; else delete process.env.CI;
      const options = harness();
      delete options.timeout;
      options.connect = async (_url, { timeout }) => {
        if (options.now() >= 35000) return {};
        options.advance(timeout);
        throw new Error('still starting');
      };
      if (ci) {
        await waitForCdp(options);
        assert.equal(options.diagnostics.connected, true);
        assert.equal(options.diagnostics.timeoutMs, 120000);
      } else {
        await assert.rejects(waitForCdp(options), /WebView2 CDP unavailable/);
        assert.equal(options.diagnostics.timeoutMs, 30000);
        assert.equal(options.diagnostics.elapsedMs, 30000);
      }
    } finally {
      if (previous === undefined) delete process.env.CI; else process.env.CI = previous;
    }
  });
}
