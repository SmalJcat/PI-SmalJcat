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
  const tasks=['running','queued','completed','failed','interrupted','cancelling'].map((status,i)=>({id:`task-${i}`,status,task:`${status}：检查工作区模块边界与相关测试`,cwd:'D:\\PI',model:'local/fixture',thinking:'high',attempts:1,createdAt:Date.now(),output:'发现 src/main.ts 负责初始化。\n建议保留边界检查并运行现有测试。',error:status==='failed'?'测试错误：进程退出，保留输出以便检查。':undefined,usage:{tokens:{input:1200,output:320,cacheRead:400},cost:.002},tools:[{id:'read-1',name:'read',status:'completed',args:'src/main.ts',output:'读取完成'}]}));
  window.themeFixture={snap,emit:event=>emit({generation:1,event})};
  window.pi={bootstrap:async()=>({preferences:{executable:'pi.exe',lastWorkspace:'D:\\PI',recentWorkspaces:[]},agentDir:'fixture',version:'0.4.1'}),connect:async()=>snap,snapshot:async()=>snap,
   sessions:async()=>[{id:'theme',name:'检查项目界面',path:'fixture',cwd:'D:\\PI',updatedAt:Date.now()}],
   files:async()=>[{name:'src',path:'src',directory:true},{name:'README.md',path:'README.md',directory:false}],
   changes:async()=>({available:true,branch:'theme-preview',files:[{path:'src/styles.css',status:' M'}]}),
   onEvent:callback=>{emit=callback;return()=>{};},onFileDrop:()=>()=>{},diagnostics:async()=>({}),
   searchFiles:async()=>({files:[{name:'main.ts',path:'src/main.ts',directory:false}],truncated:false}),
   agentTasks:async({action,id})=>action==='definition'?{thinking:'medium'}:action==='detail'?tasks.find(t=>t.id===id):{tasks,active:3,concurrency:4},
   contextStatus:async()=>({generation:1,modelKey:'fixture',model,enabled:true,usage:{tokens:32000,percent:25},triggerTokens:112000,settings:{enabled:true,reserveTokens:16000,keepRecentTokens:8000,projectTrusted:false},history:[{id:'compact-1',status:'completed',reason:'manual',createdAt:Date.now(),tokensBefore:60000,estimatedTokensAfter:16000,durationMs:1200,summary:'保留项目目标、约束与待办。'}]}),
   mcpStatus:async()=>({checkedAt:Date.now(),servers:[{name:'workspace-tools',state:'connected',tools:4,exposure:'local'},{name:'fixture-auth',state:'needs-auth',tools:0,exposure:'local'},{name:'fixture-error',state:'failed',tools:0,exposure:'local',error:'测试连接失败：请检查本地配置。'}]}),
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
  await page.getByRole('button',{name:'子代理工作台',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'子代理工作台',exact:true});await dialog.waitFor();
  const rows=dialog.locator('.agent-task-row');await rows.first().waitFor();assert.equal(await rows.count(),6);
  for(const status of ['running','queued','completed','failed','interrupted','cancelling']) {
   const row=rows.filter({has:page.locator(`.task-state.${status}`)});
   await row.focus();await page.keyboard.press('Enter');
   await dialog.locator(`.task-detail-heading .task-state.${status}`).waitFor();
   assert.equal(await row.evaluate(el=>el.classList.contains('selected')),true);
   if(status==='failed'){await dialog.locator('.task-error').waitFor();await page.screenshot({path:`${out}/agents-failed-${size.width}.png`});}
  }
  await dialog.getByRole('combobox',{name:'筛选探子状态'}).selectOption('completed');assert.equal(await rows.count(),1);
  await rows.first().click();await dialog.locator('.task-detail-heading .task-state.completed').waitFor();
  await dialog.getByText('工具活动 · 1',{exact:true}).click();
  await page.screenshot({path:`${out}/agents-${size.width}.png`});
  const detailBox=await dialog.locator('.agent-task-detail').boundingBox();assert(detailBox.width>250);
  await dialog.getByRole('button',{name:'引用结果到消息',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert((await editor.inputValue()).includes('探子任务：completed'));await editor.fill('');
  await page.getByRole('button',{name:'上下文管理',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'上下文管理',exact:true});await dialog.getByText('Fixture model',{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('progressbar',{name:'上下文使用量'}).getAttribute('value'),'32000');
  await dialog.getByText('查看压缩摘要',{exact:true}).click();
  await page.screenshot({path:`${out}/context-${size.width}.png`});
  await dialog.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  await page.getByRole('button',{name:'MCP 连接',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'MCP 连接',exact:true});await dialog.getByText('workspace-tools',{exact:true}).waitFor();
  assert.equal(await dialog.locator('.mcp-card').count(),3);
  await page.screenshot({path:`${out}/mcp-${size.width}.png`});
  await dialog.getByRole('button',{name:'刷新状态',exact:true}).click();
  await dialog.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  checks.push(`${size.width}px: composer/IME, sidebars, settings, six task states with keyboard selection, filter, reference, context history and MCP states`);
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
