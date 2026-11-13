import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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

export async function webviewDebugEndpoint(directory, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const relative of ['DevToolsActivePort', 'EBWebView/DevToolsActivePort']) {
      try {
        const value = await readFile(path.join(directory, relative), 'utf8');
        const port = Number(value.split('\n')[0].trim());
        if (Number.isInteger(port) && port > 0 && port < 65536) return 'http://127.0.0.1:' + port;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await delay(100);
  }
  throw new Error('WebView2 DevToolsActivePort unavailable in ' + directory);
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

// A separate OS process holds the same real lease as another desktop client.
export async function holdSessionLease(executable, locks, session) {
  const child = spawn(executable, [locks, session], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '', stderr = '';
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-2000); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-2000); });
  child.stdin.on('error', () => {}); // Exit during cleanup can close stdin first.
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const closed = new Promise(resolve => child.once('close', code => resolve(code)));
  const release = async () => {
    child.stdin.end();
    let timer;
    const stopped = await Promise.race([
      closed.then(code => ({ code })),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),
    ]);
    clearTimeout(timer);
    if (!stopped) {
      child.kill();
      throw new Error('Session lease helper did not exit after stdin closed');
    }
    if (spawnError) throw spawnError;
    if (stopped.code !== 0) throw new Error(`Session lease helper exited ${stopped.code}: ${stderr}`);
  };
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes('session-lease-ready')) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Session lease helper stopped: ${stderr}`);
      if (Date.now() >= deadline) throw new Error(`Session lease helper readiness timed out: ${stderr}`);
      await delay(25);
    }
    return release;
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
}
