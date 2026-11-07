// Browser-only presentation regression. The Pi bridge is a deterministic fixture;
// native Windows/WebView2 lifecycle remains covered by test:ui on Windows.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const out = process.env.PI_THEME_ARTIFACTS || 'artifacts/theme';
await mkdir(out, { recursive: true });
const candidates = process.platform === 'win32' ? [
 `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
 `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
 `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
] : ['/usr/bin/chromium'];
const executablePath = process.env.CHROMIUM_PATH || candidates.find(existsSync);
const browser = await chromium.launch({ executablePath, headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
 const errors=[]; page.on('pageerror', e=>errors.push(e.message));
 await page.addInitScript(() => {
  const model={id:'fixture',name:'Fixture model',provider:'local',reasoning:true,input:['text'],contextWindow:128000};
  const snap={generation:1,cwd:'D:\\PI',state:{sessionId:'theme',sessionName:'检查项目界面',model,thinkingLevel:'high'},messages:[],models:[model],levels:['off','high'],commands:[{name:'skill:review',description:'只读审查项目',source:'skill'},{name:'status',description:'查看状态',source:'extension'}],stats:{}};
  let emit=()=>{};
  window.themeFixture={snap,emit:event=>emit({generation:1,event})};
  window.pi={bootstrap:async()=>({preferences:{executable:'pi.exe',lastWorkspace:'D:\\PI',recentWorkspaces:[]},agentDir:'fixture',version:'0.4.1'}),connect:async()=>snap,snapshot:async()=>snap,
   sessions:async()=>[{id:'theme',name:'检查项目界面',path:'fixture',cwd:'D:\\PI',updatedAt:Date.now()}],
   files:async()=>[{name:'src',path:'src',directory:true},{name:'README.md',path:'README.md',directory:false}],
   changes:async()=>({available:true,branch:'theme-preview',files:[{path:'src/styles.css',status:' M'}]}),
   onEvent:callback=>{emit=callback;return()=>{};},onFileDrop:()=>()=>{},diagnostics:async()=>({}),
   searchFiles:async()=>({files:[{name:'main.ts',path:'src/main.ts',directory:false}],truncated:false}),
   command:async()=>({}),stop:async()=>({steering:[],followUp:[]}),window:async()=>{},sessionAccess:async()=>({available:true})};
 });
 await page.goto(process.env.PI_THEME_URL || 'http://127.0.0.1:5178');
 const editor=page.getByRole('textbox',{name:'消息',exact:true});
 await editor.waitFor();
 // The connection pill also contains the RPC badge. Match the whole pill
 // and its ready state, rather than an exact text node that does not exist.
 const connection = page.locator('.connection-pill.ready').filter({ hasText: /^Pi 本地已连接\s*RPC$/ });
 await connection.waitFor({ state: 'visible' });
 assert.equal(await connection.count(), 1);
 assert.equal((await connection.innerText()).replace(/\s+/g, ''), 'Pi本地已连接RPC');
 await page.screenshot({path:`${out}/welcome.png`});
 const checks=[];
 for(const size of [{width:1440,height:960},{width:1050,height:760}]){
  await page.setViewportSize(size);
  const bounds=await editor.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=size.width);
  await editor.fill('/');
  const menu=page.getByRole('listbox',{name:'技能与命令',exact:true});await menu.waitFor();
  await editor.press('ArrowDown');await editor.press('Tab');assert((await editor.inputValue()).startsWith('/'));
  await editor.fill('/ski');await menu.waitFor();
  await editor.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true})));
  assert.equal(await editor.inputValue(),'/ski');
  await editor.press('Escape');await menu.waitFor({state:'hidden'});
  await editor.fill('查看 @src');await page.getByRole('listbox',{name:'文件引用',exact:true}).waitFor();
  await page.screenshot({path:`${out}/completion-${size.width}.png`});
  await editor.press('Escape');
  await editor.fill('第一行');await editor.press('Shift+Enter');assert.equal(await editor.inputValue(),'第一行\n');
  await page.getByRole('button',{name:'收起侧栏',exact:true}).click();await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
  await page.getByRole('button',{name:'文件与改动',exact:true}).click();await page.getByRole('button',{name:'文件与改动',exact:true}).click();
  await editor.press('Control+,');await page.getByRole('dialog',{name:'设置与连接'}).waitFor();
  await page.screenshot({path:`${out}/settings-${size.width}.png`});
  await page.getByRole('dialog').getByRole('button',{name:'关闭弹窗',exact:true}).click();
  checks.push(`${size.width}px: editor bounds, completions, IME Enter, Escape, Shift+Enter, repeated sidebar toggles and settings close`);
 }
 await page.setViewportSize({width:1440,height:960});await editor.fill('');
 await page.evaluate(()=>{
  window.themeFixture.snap.messages=[{role:'user',content:[{type:'text',text:'请检查这个项目的结构，并给出下一步建议。'}]},{role:'assistant',content:[{type:'text',text:'## 项目检查\n\n界面由 React 和 TypeScript 构建，原生连接由 Tauri 管理。\n\n- 保留键盘快捷键与中文输入法\n- 主会话与两侧面板使用统一的深色层级\n\n```ts\nconst status = "ready";\nconsole.log(status);\n```\n\n> 先运行测试，再验证本地客户端。'}],model:'fixture'}];
  window.themeFixture.emit({type:'agent_settled'});
 });
 await page.locator('.message.assistant').waitFor();
 await page.screenshot({path:`${out}/conversation.png`});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks,errors,artifacts:out},null,2));
} finally { await browser.close(); }
