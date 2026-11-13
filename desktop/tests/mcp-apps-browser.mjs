import { chromium } from 'playwright';
import { createServer } from 'vite';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const artifacts = 'artifacts/mcp-apps';
await mkdir(artifacts, {recursive:true});
const appHtml = await readFile('tests/fixtures/mcp-app.html','utf8');
const server = await createServer({
  server:{host:'127.0.0.1',port:0},
  plugins:[{name:'mcp-app-contract-resource',configureServer(server) {
    server.middlewares.use('/mcp-app-resource',(_request,response) => {
      response.setHeader('Content-Type','text/html; charset=utf-8');
      response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
      response.end(appHtml);
    });
  }}],
});
let browser;
const errors = [], checks = [];
try {
  await server.listen();
  browser = await chromium.launch({headless:true,executablePath:process.env.CI ? undefined : [
    process.env['ProgramFiles(x86)']+'\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.ProgramFiles+'\\Google\\Chrome\\Application\\chrome.exe',
  ].find(existsSync)});
  const page = await browser.newPage({viewport:{width:1024,height:768}});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]+'tests/fixtures/mcp-app-host.html');
  const frame = page.frameLocator('iframe[title="MCP App"]');
  await frame.locator('#initial').filter({hasText:'"count":7'}).waitFor();
  assert.equal(await frame.locator('#isolation').innerText(),'parent-isolated');
  const order = await frame.locator('body').evaluate(() => window.mcpAppMessages.map(message=>message.method).filter(Boolean));
  assert.deepEqual(order,['ui/notifications/tool-input','ui/notifications/tool-result']);
  assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
  assert.ok(await page.locator('body').evaluate(el=>el.scrollHeight<=innerHeight+1));
  checks.push('标准 App 初始化、输入与结果顺序、独立来源 iframe 和布局');
  const before = await page.evaluate(()=>window.appHost.calls.length);
  await page.evaluate(()=>window.postMessage({jsonrpc:'2.0',id:999,method:'tools/call',params:{name:'spoof'}},'*'));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.appHost.calls.length),before);
  checks.push('同页伪造 postMessage 来源被拒绝');
  await frame.locator('#refresh').click();
  await frame.locator('#output').filter({hasText:'denied'}).waitFor();
  await page.evaluate(()=>{window.appHost.allow=true;});
  await frame.locator('#refresh').click();
  await frame.locator('#output').filter({hasText:'"count":42'}).waitFor();
  await page.screenshot({path:artifacts+'/frame.png'});
  checks.push('工具请求与协议成功/错误结果双向转发');
  await frame.locator('#read-resource').click();
  await frame.locator('#output').filter({hasText:'denied'}).waitFor();
  await page.evaluate(()=>{window.appHost.allowResources=true;});
  await frame.locator('#read-resource').click();
  await frame.locator('#output').filter({hasText:'你好🙂 browser resource'}).waitFor();
  await frame.locator('#read-blob').click();
  await frame.locator('#output').filter({hasText:'"blob":"AAEC"'}).waitFor();
  assert.deepEqual(await frame.locator('#output').evaluate(el=>JSON.parse(el.textContent)),{
    contents:[{uri:'fixture://binary',mimeType:'application/octet-stream',blob:'AAEC'}],
  });
  checks.push('资源请求、默认拒绝与完整 text/blob 结果转发');
  await frame.locator('#send-message').click();
  await frame.locator('#output').filter({hasText:'denied'}).waitFor();
  await page.evaluate(()=>{window.appHost.allowMessages=true;});
  await frame.locator('#send-message').click();
  await frame.locator('#output').filter({hasText:'{}'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.appHost.calls.at(-1).params),{
    role:'user',content:[{type:'text',text:'MCP_APP_CHAT_TEST'}],
  });
  checks.push('对话消息请求、授权拒绝与成功回执转发');
  await page.evaluate(()=>{window.appHost.hold=true;});
  await frame.locator('#refresh').click();
  await page.waitForFunction(()=>typeof window.appHost.release==='function');
  await page.evaluate(()=>Promise.all([window.appController.dispose(),window.appController.dispose()]));
  assert.equal(await page.locator('iframe').count(),0);
  assert.equal(await page.evaluate(()=>window.appHost.teardownAcknowledged),true);
  await page.evaluate(()=>window.appHost.release());
  await page.waitForTimeout(50);
  assert.deepEqual(errors,[]);
  checks.push('teardown 回执、移除监听与迟到结果清理');
  await writeFile(artifacts+'/result.json',JSON.stringify({success:true,checks,errors},null,2)+'\n');
  console.log('MCP Apps browser: '+checks.length+' checks passed');
} catch (error) {
  await writeFile(artifacts+'/result.json',JSON.stringify({success:false,checks,errors,error:String(error)},null,2)+'\n');
  throw error;
} finally {
  try { await browser?.close(); } finally { await server.close(); }
}
