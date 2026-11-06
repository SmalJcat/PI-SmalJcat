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
