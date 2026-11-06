import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { debugEndpoint, waitForProcessExit } from './tauri-harness.mjs';
const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-tauri-dev-'));
const resultFile = path.join(root, 'artifacts', 'tauri-dev-result.json');
await mkdir(path.dirname(resultFile), { recursive: true });
await writeFile(resultFile, JSON.stringify({ success: false, version, startedAt: new Date().toISOString() }, null, 2) + '\n');
const debug = await debugEndpoint();
const env = { ...process.env, PI_DESKTOP_USER_DATA: temp, PI_DESKTOP_WORKSPACE: root, PI_CODING_AGENT_DIR: path.join(temp,'agent'), PI_DESKTOP_TEST:'1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:debug.args };
delete env.PI_DESKTOP_DEBUG_PORT;
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(process.execPath, ['scripts/native.mjs','dev','--features','test-fixture','--no-watch'], { cwd:root, env, stdio:['ignore','pipe','pipe'] });
let output = '', browser;
for(const stream of [child.stdout,child.stderr]) stream.on('data',bytes=>{output=(output+bytes.toString()).slice(-10000);});
try {
  const deadline=Date.now()+45000;
  while(Date.now()<deadline) {
    if(child.exitCode!==null) throw new Error(output);
    try { browser=await chromium.connectOverCDP(debug.url,{timeout:800}); break; } catch { await delay(300); }
  }
  assert.ok(browser,output);
  const page=browser.contexts()[0].pages()[0];
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.locator('.connection-pill.ready').waitFor({timeout:20000});
  assert.equal(new URL(page.url()).port,'5178');
  const info = await page.evaluate(async()=>({bootstrap:await window.pi.bootstrap(),diagnostics:await window.pi.diagnostics()}));
  assert.equal(info.bootstrap.runtime,'tauri');
  assert.equal(info.bootstrap.version,version);
  assert.equal(path.resolve(info.diagnostics.preferencesPath),path.join(temp,'preferences.json'));
  assert.deepEqual(errors,[]);
  const processExited = once(child,'exit');
  await page.evaluate(()=>{void window.pi.window('close');});
  await Promise.race([processExited,delay(10000).then(()=>{throw new Error('Dev runner did not exit');})]);
  assert.equal(child.exitCode,0);
  await waitForProcessExit(info.diagnostics.pid);
  await writeFile(resultFile,JSON.stringify({success:true,version,completedAt:new Date().toISOString(),rendererErrors:errors,modelRequests:0,piProcessExited:true},null,2)+'\n');
  console.log('Tauri + Vite development window connected and closed successfully.');
} catch(error) { await writeFile(resultFile,JSON.stringify({success:false,version,completedAt:new Date().toISOString(),error:error.stack||String(error)},null,2)+'\n'); console.error(output); throw error; }
finally {
  if(browser) await browser.close().catch(()=>{});
  if(child.exitCode===null) { const kill=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true}); await once(kill,'exit'); }
  await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
