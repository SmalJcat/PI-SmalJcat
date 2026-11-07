import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export async function debugEndpoint() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return {
    url: `http://127.0.0.1:${port}`,
    args: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  };
}

export async function waitForProcessExit(pid, timeout = 5000) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid Pi process ID: ${pid}`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(100);
  }
  throw new Error(`Pi process ${pid} survived application shutdown`);
}

// Keep one overall deadline: a slow handshake must not consume an unbounded retry.
export async function waitForCdp({ connect, url, processState, diagnostics = {},
  timeout = process.env.CI ? 120000 : 30000, attemptTimeout = 5000,
  retryDelay = 250, log = console.log, now = Date.now, sleep = delay }) {
  const started = now();
  const deadline = started + timeout;
  Object.assign(diagnostics, { url, timeoutMs: timeout, attempts: 0 });
  let nextLog = started;
  const fail = reason => {
    throw new Error(`${reason}\n${JSON.stringify(diagnostics, null, 2)}`);
  };
  while (now() < deadline) {
    diagnostics.process = processState();
    diagnostics.elapsedMs = now() - started;
    if (diagnostics.process.spawnError || diagnostics.process.exitCode !== null || diagnostics.process.signalCode) {
      fail('Tauri stopped before WebView2 CDP became available');
    }
    diagnostics.attempts++;
    try {
      const browser = await connect(url, { timeout: Math.min(attemptTimeout, deadline - now()) });
      diagnostics.elapsedMs = now() - started;
      diagnostics.process = processState();
      diagnostics.connected = true;
      log(`WebView2 CDP connected after ${diagnostics.elapsedMs}ms (${diagnostics.attempts} attempts)`);
      return browser;
    } catch (error) {
      diagnostics.lastError = (error.stack || String(error)).slice(-8000);
      diagnostics.firstError ??= diagnostics.lastError;
      diagnostics.elapsedMs = now() - started;
      if (now() >= nextLog) {
        log(`Waiting for WebView2 CDP at ${url}: attempt ${diagnostics.attempts}, ${diagnostics.elapsedMs}/${timeout}ms\n${diagnostics.lastError}`);
        nextLog = now() + 10000;
      }
    }
    await sleep(Math.min(retryDelay, Math.max(0, deadline - now())));
  }
  diagnostics.elapsedMs = now() - started;
  diagnostics.process = processState();
  fail('WebView2 CDP unavailable');
}
