import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-desktop-packaged-'));
const env = { ...process.env, PI_DESKTOP_USER_DATA: temp, PI_DESKTOP_WORKSPACE: root };
delete env.ELECTRON_RUN_AS_NODE; delete env.PI_DESKTOP_TEST; delete env.PI_DESKTOP_DEV;
const errors = [];
let app;
try {
  app = await electron.launch({ executablePath: path.join(root, 'release/win-unpacked/Pi Desktop.exe'), args: [], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.connection-pill.ready').waitFor({ timeout: 45000 });
  const info = await page.evaluate(async () => ({ bootstrap: await window.pi.bootstrap(), snapshot: await window.pi.snapshot(), diagnostics: await window.pi.diagnostics() }));
  assert.ok(info.snapshot.models.length > 0);
  assert.ok(info.snapshot.commands.length > 0);
  assert.equal(path.resolve(info.snapshot.cwd), root);
  assert.equal(info.diagnostics.connected, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.getByRole('button', { name: 'README.md', exact: true }).waitFor();
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts/desktop-real.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ packaged: true, modelCount: info.snapshot.models.length, commandCount: info.snapshot.commands.length, workspace: info.snapshot.cwd, executable: info.bootstrap.preferences.executable, rendererErrors: errors }, null, 2));
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
