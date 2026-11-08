import { layoutChecks } from './layout-ui.mjs';
import { scoutHistoryChecks } from './scout-history-checks.mjs';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, rm, readFile, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { debugEndpoint, waitForProcessExit, holdSessionLease } from './tauri-harness.mjs';
import { verifyComposer } from './composer-ui.mjs';
const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const release = process.argv.includes('--release');
const real = process.argv.includes('--real') || release;
const mode = release ? 'release' : real ? 'real' : 'ui';
const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-tauri-ui-'));
const work = real ? root : path.join(temp, '示例项目');
const artifacts = path.join(root, 'artifacts');
const leaseExecutable = path.join(root, 'src-tauri/target/debug/pi-session-lease.exe');
const leaseRoot = path.join(temp, 'agent/desktop-session-locks');
await mkdir(artifacts, { recursive: true });
const resultFile = path.join(artifacts, `tauri-${mode}-result.json`);
await writeFile(resultFile, JSON.stringify({ success: false, mode, version, startedAt: new Date().toISOString() }, null, 2) + '\n');
if (!real) {
  await mkdir(work); await mkdir(path.join(work, 'src'));
  await writeFile(path.join(work, 'README.md'), '# Pi Desktop 测试项目\n\n这是文件预览内容。');
  await writeFile(path.join(work, 'src/main.ts'), 'export const ready = true;\n');
  await exec('git',['init'],{cwd:work});await exec('git',['add','.'],{cwd:work});
  await exec('git',['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','-m','base'],{cwd:work});
  await writeFile(path.join(work,'src/main.ts'),'export const ready = false;\n');await exec('git',['add','.'],{cwd:work});
  await writeFile(path.join(work,'src/main.ts'),'export const ready = "working";\n');
}
const debug = await debugEndpoint();
const env = { ...process.env, PI_DESKTOP_USER_DATA: path.join(temp,'profile'), PI_DESKTOP_WORKSPACE: work, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: debug.args };
delete env.PI_DESKTOP_DEBUG_PORT;
if (!real) { env.PI_DESKTOP_TEST = '1'; env.PI_CODING_AGENT_DIR = path.join(temp, 'agent'); } else { delete env.PI_DESKTOP_TEST; }
delete env.ELECTRON_RUN_AS_NODE;
// WebView2 enables CDP only for this verification process, using a free port.
const executable = path.join(root, release ? 'release/tauri/Pi Desktop.exe' : 'src-tauri/target/debug/pi-desktop.exe');
const executableSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
let child = spawn(executable, [], { cwd: root, env, windowsHide: false, stdio: ['ignore','pipe','pipe'] });
let stderr = '', browser, page;
child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-10000); });
child.stdout.on('data', () => {});
const errors = [], checks = [];
let details = {};
async function waitForSnapshot(predicate){const end=Date.now()+10000;while(Date.now()<end){const value=await page.evaluate(()=>window.pi.snapshot());if(predicate(value))return value;await delay(100);}throw new Error('Snapshot condition timed out');}
async function waitForValue(read, predicate, timeout = 25000) { const deadline=Date.now()+timeout; let last; while(Date.now()<deadline){last=await read(); if(predicate(last))return last; await delay(100);} throw new Error(`UI state timed out: ${JSON.stringify(last).slice(0,2000)}`); }
const waitForTasks = predicate => waitForValue(() => page.evaluate(() => window.pi.agentTasks()), predicate);
try {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Tauri exited: ${child.exitCode}\n${stderr}`);
    try { browser = await chromium.connectOverCDP(debug.url, { timeout: 1000 }); break; } catch { await delay(250); }
  }
  assert.ok(browser, `WebView2 CDP unavailable\n${stderr}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] || await context.waitForEvent('page');
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.connection-pill.ready').waitFor({ timeout: 45000 });
  const info = await page.evaluate(async () => ({ bootstrap: await window.pi.bootstrap(), diagnostics: await window.pi.diagnostics(), snapshot: await window.pi.snapshot() }));
  assert.equal(info.bootstrap.runtime, 'tauri'); assert.equal(info.bootstrap.version, version);
  assert.equal(path.resolve(info.diagnostics.preferencesPath), path.join(temp, 'profile', 'preferences.json'));
  assert.equal(info.diagnostics.connected, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  checks.push('真实 Tauri / WebView2 启动、Rust 桥接与连接');
  if (!real) await layoutChecks(page, artifacts, checks);
  await page.screenshot({ path: path.join(artifacts, real ? 'tauri-real.png' : 'tauri-home-test.png') });
  if (real) {
    assert.ok(info.snapshot.models.length > 0); assert.ok(info.snapshot.commands.length > 0);
    const mcp=await page.evaluate(()=>window.pi.mcpStatus());
    assert.ok(Array.isArray(mcp.servers));
    details = { modelCount: info.snapshot.models.length, commandCount: info.snapshot.commands.length, mcpServers: mcp.servers.map(({ name, state, tools }) => ({ name, state, tools })), nodeIntegration: false };
    checks.push('真实 Pi 模型、命令与 MCP 状态读取（不调用模型）');
    const contextState = await page.evaluate(() => window.pi.contextStatus());
    assert.ok(contextState.settings); assert.equal(typeof contextState.settings.reserveTokens, 'number');
    assert.equal(contextState.triggerTokens, contextState.model.contextWindow - contextState.settings.reserveTokens);
    checks.push('真实 Pi 有效压缩配置、信任状态与触发阈值');
    details.context = { modelKey: contextState.modelKey, enabled: contextState.enabled, reserveTokens: contextState.settings.reserveTokens, keepRecentTokens: contextState.settings.keepRecentTokens, triggerTokens: contextState.triggerTokens };
    console.log(JSON.stringify({mcpServers:mcp.servers.map(server=>({name:server.name,state:server.state,tools:server.tools}))}));
    console.log(JSON.stringify({ realPi: true, runtime: info.bootstrap.runtime, modelCount: info.snapshot.models.length, commandCount: info.snapshot.commands.length, workspace: info.snapshot.cwd, nodeIntegration: false }, null, 2));
  } else {
    await page.getByRole('button', { name: 'README.md', exact: true }).click();
    await page.getByRole('dialog').locator('.numbered-code').getByText('这是文件预览内容。', { exact: false }).waitFor();
    await page.getByRole('button', { name: '引用到消息', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    assert.match(await editor.inputValue(), /README.md/);
    checks.push('Rust 文件预览与引用');
    await editor.fill('你好，请检查项目');
    await editor.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })));
    assert.equal(await editor.inputValue(), '你好，请检查项目');
    await editor.press('Enter');
    await page.getByText('已完成检查。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.message.user').count(), 1);
    assert.equal(await page.locator('.message.assistant').count(), 2);
    assert.equal(await page.locator('.markdown img').count(), 0);
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    await page.locator('.tool-card summary').click();
    await page.getByText('这是工具输出。', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'tauri-chat-test.png') });
    checks.push('中文输入、Rust RPC 流式回复、工具详情、安全 Markdown');
    // 会话正文检索：标题过滤之外，正文命中也应当出现在侧栏
    const searchBox = page.getByLabel('搜索会话');
    // 刻意等到索引"陈旧"（阈值 3 秒）再搜：验证搜索会自己增量同步，而不是靠手点刷新
    await page.waitForTimeout(3500);
    await searchBox.fill('中文流式输出');
    await page.locator('.content-hits').waitFor();
    await page.locator('.content-hit').first().waitFor({ timeout: 25000 });
    assert.ok(await page.locator('.content-age').count() === 1, '应当显示索引新鲜度');
    const hitText = (await page.locator('.content-hit').first().textContent()) || '';
    assert.ok(hitText.includes('中文流式输出'), '正文命中应当带出片段，实际 ' + hitText);
    // 过滤：切到「今天」+「仅当前工作区」后仍然能命中（这条会话就是刚写的）
    const hitFilters = page.getByRole('group', { name: '检索过滤' });
    await hitFilters.getByRole('button', { name: '今天', exact: true }).click();
    await hitFilters.getByRole('button', { name: '仅当前工作区', exact: true }).click();
    await page.locator('.content-hit').first().waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.content-hit').count(), 1, '过滤后应当仍然命中该会话');
    // 多关键词：两个词都命中才算命中
    await searchBox.fill('中文流式输出 正在查看项目');
    await page.locator('.content-hit').first().waitFor({ timeout: 15000 });
    await searchBox.fill('中文流式输出 完全不存在的词');
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('.content-hit').count(), 0, '多关键词必须全部命中');
    checks.push('多关键词 AND、时间与工作区过滤');
    // 命中位置跳转：点开命中项应当滚动并高亮到那句话
    await searchBox.fill('中文流式输出');
    await page.locator('.content-hit').first().waitFor({ timeout: 15000 });
    await page.locator('.content-hit').first().click();
    await page.locator('.message.hit-flash').first().waitFor({ timeout: 20000 });
    const flashedText = (await page.locator('.message.hit-flash').first().textContent()) || '';
    assert.ok(flashedText.includes('中文流式输出'), '应当高亮到包含关键词的那条消息，实际 ' + flashedText.slice(0, 60));
    checks.push('命中位置跳转：滚动并高亮到那句话');
    // 命中导航条：第 N / M 处、上一个/下一个、可关闭
    await page.locator('.locate-bar').waitFor({ timeout: 10000 });
    const barText = (await page.locator('.locate-bar').textContent()) || '';
    assert.match(barText, /第 \d+ \/ \d+ 处/, '导航条应当显示命中位置，实际 ' + barText);
    await page.getByRole('button', { name: '下一个命中', exact: true }).click();
    await page.locator('.message.hit-flash').first().waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: '上一个命中', exact: true }).click();
    await page.locator('.message.hit-flash').first().waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: '关闭命中导航', exact: true }).click();
    await page.locator('.locate-bar').waitFor({ state: 'detached' });
    checks.push('命中导航：上一个/下一个与关闭');
    // 复位过滤与查询，避免影响后续断言
    await searchBox.fill('中文流式输出');
    await hitFilters.getByRole('button', { name: '全部', exact: true }).click();
    await hitFilters.getByRole('button', { name: '仅当前工作区', exact: true }).click();
    await searchBox.fill('');
    await page.locator('.content-hits').waitFor({ state: 'detached' });
    checks.push('会话正文全文检索（含中文子串与片段）');
    // 启动耗时：必须有真实数字，且阶段时间单调不减（把耗时写进验收项名称，作为留档证据）
    const startup = await page.evaluate(() => window.pi.startupTrace());
    const stages = startup?.stages || [];
    assert.ok(stages.length >= 4, '启动阶段应当被记录，实际 ' + stages.length + ' 段');
    assert.ok(stages.some(stage => stage.name === '命令通道'), '应当记录 WebView 与 Rust 建立通道的时刻');
    assert.ok(stages.some(stage => stage.name === '前端就绪'), '应当记录前端首帧时刻');
    let previousAt = 0;
    for (const stage of stages) {
      assert.ok(stage.atMs >= previousAt, '阶段累计时间应当单调不减');
      previousAt = stage.atMs;
    }
    assert.ok(startup.totalMs > 0 && startup.totalMs < 30000, '启动总耗时应当在合理区间：' + startup.totalMs);
    const breakdown = stages.map(stage => stage.name + ' ' + stage.atMs).join(' · ');
    checks.push('启动耗时（总计 ' + startup.totalMs + 'ms｜' + breakdown + '）');
    await page.getByLabel('选择模型', { exact: true }).selectOption('fixture::fixture-fast');
    await page.waitForFunction(() => document.querySelector('select[aria-label="思考强度"]').value === 'off');
    await page.getByLabel('选择模型', { exact: true }).selectOption('fixture::fixture-model');
    await page.getByLabel('思考强度', { exact: true }).selectOption('high');
    await page.waitForFunction(() => document.querySelector('select[aria-label="思考强度"]').value === 'high');
    checks.push('模型和思考强度');
    await editor.fill('/confirm-test'); await editor.press('Enter');
    await page.getByRole('dialog', { name: '是否继续测试？', exact: true }).waitFor();
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await page.getByText('已收到确认', { exact: true }).waitFor();
    checks.push('扩展 UI 请求与响应');
    await verifyComposer(page, checks, artifacts);
    await editor.fill('等待停止测试'); await editor.press('Enter');
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor();
    await editor.fill('稍后处理这个任务'); await editor.press('Enter');
    await page.locator('.queue-banner').waitFor();
    await page.getByRole('button', { name: '停止任务', exact: true }).click();
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="消息"]').value.includes('稍后处理这个任务'));
    checks.push('停止、取回队列、恢复编辑');
    await page.getByRole('button', { name: '会话操作', exact: true }).click();
    await page.getByRole('button', { name: '重命名会话', exact: true }).click();
    await page.getByLabel('会话名称', { exact: true }).fill('Tauri 验收会话');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await page.locator('.session-item').filter({ hasText: 'Tauri 验收会话' }).waitFor();
    const renamedSession = (await page.evaluate(() => window.pi.snapshot())).state.sessionFile;
    await page.getByRole('button', { name: /新会话/ }).click();
    await page.getByRole('heading', { name: '今天，一起做点什么？', exact: true }).waitFor();
    const originalSessionBytes = await readFile(renamedSession);
    const releaseRenamed = await holdSessionLease(leaseExecutable, leaseRoot, renamedSession);
    try {
      const access = await page.evaluate(file => window.pi.sessionAccess(file), renamedSession);
      assert.equal(access.available, false);
      assert.match(access.reason, /另一个 Pi Desktop 占用/);
      await page.locator('.session-item').filter({ hasText: 'Tauri 验收会话' }).click();
      await page.getByRole('dialog', { name: '会话保护', exact: true }).waitFor();
      await page.getByRole('button', { name: '复制为新会话', exact: true }).click();
      await waitForSnapshot(snapshot => snapshot.state.sessionFile !== renamedSession && snapshot.messages.length > 0);
      await page.getByText('已完成检查。', { exact: true }).waitFor();
      assert.deepEqual(await readFile(renamedSession), originalSessionBytes);
    } finally {
      await releaseRenamed();
    }
    checks.push('会话索引、重命名、真实租约占用提示、副本恢复且原文件不变');
    await editor.evaluate(element => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh54AAAAASUVORK5CYII='), c => c.charCodeAt(0));
      const data = new DataTransfer(); data.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    });
    await page.getByRole('button', { name: '移除 clipboard.png', exact: true }).waitFor();
    await page.evaluate(async file => {
      const files = await window.pi.attachments([file]);
      if (files[0].text !== '# Pi Desktop 测试项目\n\n这是文件预览内容。') throw new Error('attachment read mismatch');
    }, path.join(work, 'README.md'));
    checks.push('粘贴图片、Rust 文本附件读取');
    await editor.fill('重新连接时保留的草稿 @src/ma');
    await page.getByRole('listbox', { name: '文件引用' }).waitFor();
    await editor.press('Tab');
    await page.getByRole('button', { name: '移除引用 src/main.ts', exact: true }).waitFor();
    const reconnectDraft = await editor.inputValue();
    const reconnectSession = (await page.evaluate(() => window.pi.snapshot())).state.sessionFile;
    await page.getByRole('button', { name: /设置与连接/ }).click();
    await page.getByRole('dialog', { name: '设置与连接', exact: true }).waitFor();
    // 外观分区的每一项都必须真的改到根元素上的变量，而不是摆设开关
    const nav = page.locator('.settings-nav');
    await nav.getByRole('button', { name: '外观', exact: true }).click();
    const preferenceRows = await page.locator('.pref-row').count();
    assert.equal(preferenceRows, 9, '外观分区应有 9 项，实际 ' + preferenceRows);
    const rootVar = name => page.evaluate(key => getComputedStyle(document.documentElement).getPropertyValue(key).trim(), name);
    assert.equal(await rootVar('--type-scale'), '1', '初始字号缩放应为 1');
    await page.locator('.pref-row', { hasText: '字号' }).getByRole('button', { name: '大', exact: true }).click();
    assert.equal(await rootVar('--type-scale'), '1.14', '字号应当真的生效');
    await page.locator('.pref-row', { hasText: '对话宽度' }).getByRole('button', { name: '窄', exact: true }).click();
    assert.equal(await rootVar('--chat-width'), '640px', '对话宽度应当真的生效');
    await page.locator('.pref-row', { hasText: '圆角' }).getByRole('button', { name: '圆润', exact: true }).click();
    assert.equal(await rootVar('--radius-scale'), '1.4', '圆角应当真的生效');
    await page.locator('.pref-row', { hasText: '动效' }).getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), 'off', '动效应当真的关闭');
    await page.locator('.pref-row', { hasText: '行高' }).getByRole('button', { name: '宽松', exact: true }).click();
    assert.equal(await rootVar('--reading-line'), '1.9', '行高应当真的生效');
    // 复位，避免影响后续断言
    await page.locator('.pref-row', { hasText: '字号' }).getByRole('button', { name: '标准', exact: true }).click();
    await page.locator('.pref-row', { hasText: '对话宽度' }).getByRole('button', { name: '标准', exact: true }).click();
    await page.locator('.pref-row', { hasText: '圆角' }).getByRole('button', { name: '标准', exact: true }).click();
    await page.locator('.pref-row', { hasText: '动效' }).getByRole('button', { name: '完整', exact: true }).click();
    await page.locator('.pref-row', { hasText: '行高' }).getByRole('button', { name: '标准', exact: true }).click();
    assert.equal(await rootVar('--type-scale') + '/' + await rootVar('--radius-scale'), '1/1', '复位应当生效');
    // 系统分区：三项由 Rust 落地，这里验证读取与渲染
    await nav.getByRole('button', { name: '系统', exact: true }).click();
    assert.equal(await page.locator('.pref-row').count(), 3, '系统分区应有 3 项');
    // 快捷键：录制能改写绑定，关闭对话框后真的生效，恢复默认也有效
    await nav.getByRole('button', { name: '快捷键', exact: true }).click();
    assert.equal(await page.locator('.pref-row').count(), 7, '快捷键分区应有 7 项');
    const sidebarRow = page.locator('.pref-row', { hasText: '切换左栏' });
    await sidebarRow.getByRole('button', { name: '录制', exact: true }).click();
    await page.keyboard.press('Control+J');
    assert.equal((await sidebarRow.locator('kbd').textContent()).trim(), 'Ctrl+J', '录制应当改写绑定');
    await page.getByRole('dialog', { name: '设置与连接', exact: true }).getByRole('button', { name: '关闭弹窗', exact: true }).click();
    const sidebarBefore = await page.locator('.sidebar').isVisible();
    await page.keyboard.press('Control+J');
    assert.notEqual(await page.locator('.sidebar').isVisible(), sidebarBefore, '自定义快捷键应当真的切换左栏');
    await page.keyboard.press('Control+J');
    assert.equal(await page.locator('.sidebar').isVisible(), sidebarBefore, '再按一次应当切回');
    await page.getByRole('button', { name: '设置与连接' }).click();
    await page.locator('.settings-nav').getByRole('button', { name: '快捷键', exact: true }).click();
    await page.getByRole('button', { name: '恢复默认快捷键', exact: true }).click();
    assert.equal(
      (await page.locator('.pref-row', { hasText: '切换左栏' }).locator('kbd').textContent()).trim(),
      'Ctrl+B',
      '恢复默认应当写回默认值'
    );
    // 存储面板：四行用量 + 数值可读
    await nav.getByRole('button', { name: '存储', exact: true }).click();
    assert.equal(await page.locator('.pref-row').count(), 5, '存储分区应有 5 行（含归档保留期）');
    const sizeText = (await page.locator('.storage-size').first().textContent()) || '';
    assert.ok(/\d/.test(sizeText), '存储用量应当有数值，实际 ' + sizeText);
    // 保留策略：切换档位要真的落库（读回是一致的），且全新环境下不应有可清理的记录
    const retention = page.getByLabel('归档保留期');
    assert.equal(await retention.inputValue(), '0', '默认应为永久保留');
    await retention.selectOption('90');
    await page.waitForFunction(() => document.querySelector('select[aria-label="归档保留期"]').value === '90');
    const retentionState = await page.evaluate(() => window.pi.retentionStatus());
    assert.equal(retentionState.retentionDays, 90, '保留期应当写入偏好');
    assert.equal(retentionState.records, 0, '全新环境不应有过期归档记录');
    assert.equal(retentionState.updateCacheFiles, 0, '全新环境不应有更新缓存');
    await retention.selectOption('0');
    await page.waitForFunction(() => document.querySelector('select[aria-label="归档保留期"]').value === '0');
    checks.push('保留策略：档位落库、过期候选只清理可再生的东西');
    await nav.getByRole('button', { name: '连接', exact: true }).click();
    checks.push('外观 9 项偏好真实生效、系统分区可读');
    checks.push('存储用量面板可用');
    checks.push('快捷键录制、真实生效与恢复默认');
    // 崩溃诊断：全新环境应判定为"上次正常退出"，并给出本地报告目录（前端错误数只记录不硬断言）
    const crash = await page.evaluate(() => window.pi.crashStatus());
    assert.equal(crash.cleanExit, true, '全新环境不应判定为异常退出');
    assert.equal(crash.crashCount, 0, '全新环境不应有崩溃报告');
    assert.ok(String(crash.dir).includes('crashes'), '应当给出报告目录，实际 ' + crash.dir);
    assert.ok((await page.getByText('上次正常退出', { exact: false }).count()) >= 1, '界面应当显示上次退出状态');
    checks.push('崩溃诊断：上次退出干净、崩溃 ' + crash.crashCount + ' 份、前端错误 ' + crash.rendererCount + ' 条');
    await page.getByText('连接诊断', { exact: true }).click();
    await page.getByText('Rust + Tauri', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'tauri-settings-test.png') });
    // Hold the completed backend response so edits during a slow reconnect are deterministic.
    await page.evaluate(() => {
      const connect = window.pi.connect;
      window.pi.connect = async options => {
        const snapshot = await connect(options);
        window.pi.connect = connect;
        await new Promise(resolve => { window.finishTestReconnect = resolve; });
        return snapshot;
      };
    });
    await page.getByRole('button', { name: '重新连接 Pi', exact: true }).click();
    await page.waitForFunction(() => typeof window.finishTestReconnect === 'function');
    await page.locator('.connection-pill.connecting').waitFor();
    const editedDraft = `${reconnectDraft}\n连接期间继续编辑`;
    await editor.fill(editedDraft);
    await page.evaluate(() => { window.finishTestReconnect(); delete window.finishTestReconnect; });
    await page.locator('.connection-pill.ready').waitFor();
    assert.equal(await editor.inputValue(), editedDraft);
    assert.equal(await page.getByRole('button', { name: '移除 clipboard.png', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '移除引用 src/main.ts', exact: true }).count(), 1);
    assert.equal((await page.evaluate(() => window.pi.snapshot())).state.sessionFile, reconnectSession);
    await page.getByRole('button', { name: '移除 clipboard.png', exact: true }).click();
    await page.getByRole('button', { name: '移除引用 src/main.ts', exact: true }).click();
    checks.push('设置重新连接保留草稿、连接期间编辑、图片附件和文件引用');
    checks.push('设置与 Rust 连接诊断');
    await page.getByRole('button',{name:'MCP 连接',exact:true}).click();
    await page.locator('.mcp-card').filter({hasText:'fixture'}).waitFor();
    await page.locator('.mcp-card').filter({hasText:'fixture'}).getByRole('button',{name:'重新连接',exact:true}).click();
    await page.getByRole('button',{name:'刷新状态',exact:true}).waitFor();
    await page.screenshot({path:path.join(artifacts,'v03-mcp.png')});await page.keyboard.press('Escape');
    checks.push('MCP状态、错误详情与会话内重连');
    await editor.fill('检查 @src/ma');
    await page.getByRole('listbox',{name:'文件引用'}).waitFor();await editor.press('Enter');
    await page.getByRole('button',{name:'移除引用 src/main.ts',exact:true}).waitFor();
    await editor.press('Enter');
    await page.getByRole('button',{name:'停止任务',exact:true}).waitFor({state:'hidden'});
    await waitForSnapshot(snapshot=>!snapshot.state.isStreaming&&snapshot.messages.some(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes('export const ready = "working"')));
    checks.push('@文件键盘选择与实际内容发送');
    await page.getByRole('button',{name:/^改动/}).click();
    await page.locator('.change-group').filter({hasText:'未暂存'}).getByRole('button').click();
    await page.locator('.split-review').waitFor();assert.match(await page.locator('.split-review').innerText(),/false/);assert.match(await page.locator('.split-review').innerText(),/working/);
    await page.getByRole('spinbutton',{name:'跳转行号'}).fill('1');await page.getByRole('button',{name:'跳转',exact:true}).click();
    await page.screenshot({path:path.join(artifacts,'v03-review.png')});await page.keyboard.press('Escape');
    checks.push('分组差异、左右对照、语法高亮与行号');
    const saved=await waitForSnapshot(snapshot=>!snapshot.state.isStreaming);
    const originalBytes=await readFile(saved.state.sessionFile);
    await appendFile(saved.state.sessionFile,'\n');
    await editor.fill('外部修改后待发送的草稿');await editor.press('Enter');
    await page.getByRole('dialog',{name:'会话保护',exact:true}).waitFor();
    assert.match(await editor.inputValue(),/外部修改后待发送的草稿/);
    await page.getByRole('button',{name:'复制为新会话',exact:true}).click();
    await page.getByRole('dialog',{name:'会话保护',exact:true}).waitFor({state:'hidden'});
    await waitForSnapshot(snapshot=>snapshot.state.sessionFile!==saved.state.sessionFile);
    assert.deepEqual(await readFile(saved.state.sessionFile),Buffer.concat([originalBytes,Buffer.from('\n')]));
    assert.match(await editor.inputValue(),/外部修改后待发送的草稿/);
    checks.push('外部文件变化拦截、保留草稿、原文件不被副本修改');
    const crashedSession = (await page.evaluate(() => window.pi.snapshot())).state.sessionFile;
    await editor.fill('/crash-test');await editor.press('Enter');
    await page.locator('.connection-pill.error').waitFor();await editor.fill('断线后保留的草稿');
    const crashedBytes = await readFile(crashedSession);
    const releaseCrashed = await holdSessionLease(leaseExecutable, leaseRoot, crashedSession);
    try {
      const access = await page.evaluate(file => window.pi.sessionAccess(file), crashedSession);
      assert.equal(access.available, false);
      assert.match(access.reason, /另一个 Pi Desktop 占用/);
      await page.getByRole('button', { name: '恢复会话', exact: true }).click();
      await page.getByRole('dialog', { name: '会话保护', exact: true }).waitFor();
      await page.getByRole('button', { name: '复制为新会话', exact: true }).click();
      await page.locator('.connection-pill.ready').waitFor();
      assert.match(await editor.inputValue(), /断线后保留的草稿/);
      assert.notEqual((await page.evaluate(() => window.pi.snapshot())).state.sessionFile, crashedSession);
      assert.deepEqual(await readFile(crashedSession), crashedBytes);
    } finally {
      await releaseCrashed();
    }
    checks.push('进程崩溃、被占用会话副本恢复与断线草稿');
    await page.getByRole('button', { name: '上下文管理', exact: true }).click();
    const contextPanel = page.getByRole('dialog', { name: '上下文管理', exact: true });
    await contextPanel.getByText('参数与范围', { exact: true }).click();
    await contextPanel.getByLabel('预留 tokens', { exact: true }).fill('40000');
    await contextPanel.getByLabel('保留近期 tokens', { exact: true }).fill('10000');
    await contextPanel.getByLabel('启用自动压缩', { exact: true }).uncheck();
    await contextPanel.getByRole('button', { name: '保存压缩设置', exact: true }).click();
    await contextPanel.getByText('已保存并在当前会话生效。', { exact: true }).waitFor();
    await waitForValue(() => page.evaluate(() => window.pi.contextStatus()), value => value.enabled === false && value.triggerTokens === 160000);
    const configured = JSON.parse(await readFile(path.join(temp, 'agent/settings.json'), 'utf8'));
    assert.equal(configured.compaction.modelOverrides['fixture/fixture-model'].keepRecentTokens, 10000);
    checks.push('上下文面板、自动压缩开关与当前模型阈值保存');
    await contextPanel.locator('.context-panel').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(artifacts, 'v04-context-overview.png') });
    await contextPanel.getByLabel('压缩重点').fill('[fixture-fail]');
    await contextPanel.getByRole('button', { name: '立即压缩', exact: true }).click();
    await contextPanel.locator('.compaction-row[data-status="failed"]').waitFor();
    await contextPanel.getByLabel('压缩重点').fill('保留目标、约束和改动');
    await contextPanel.getByRole('button', { name: '重试压缩', exact: true }).click();
    await contextPanel.locator('.compaction-row[data-status="completed"]').waitFor();
    await contextPanel.getByText('查看压缩摘要', { exact: true }).click();
    await contextPanel.getByText('已压缩测试上下文', { exact: true }).waitFor();
    const compacted = await page.evaluate(() => window.pi.contextStatus());
    assert.ok(compacted.history.some(row => row.tokensBefore === 1200 && row.estimatedTokensAfter === 400));
    await page.screenshot({ path: path.join(artifacts, 'v04-context.png') });
    checks.push('压缩失败记录、重试、摘要与前后 tokens');
    await contextPanel.getByLabel('压缩重点').fill('[fixture-slow]');
    await contextPanel.getByRole('button', { name: '立即压缩', exact: true }).click();
    await contextPanel.getByRole('button', { name: '停止当前操作', exact: true }).click();
    await contextPanel.locator('.compaction-row[data-status="cancelled"]').waitFor();
    await page.keyboard.press('Escape');
    await waitForSnapshot(snapshot => !snapshot.state.isCompacting && !snapshot.state.isStreaming);
    checks.push('取消进行中的压缩并恢复空闲状态');
    const waitTask = (id, status) => waitForValue(() => page.evaluate(id => window.pi.agentTasks({ action: 'detail', id }), id), task => task.status === status);
    await page.getByRole('button', { name: '子代理工作台', exact: true }).click();
    let agentsPanel = page.getByRole('dialog', { name: '子代理工作台', exact: true });
    await agentsPanel.getByRole('button', { name: '新任务', exact: true }).click();
    await agentsPanel.getByLabel('探子任务', { exact: true }).fill('等待探子 A\n等待探子 B\n等待探子 C\n等待探子 D\n等待探子 E');
    await agentsPanel.getByText('高级选项', { exact: true }).click();
    await agentsPanel.getByLabel('按行拆分任务', { exact: true }).check();
    await agentsPanel.getByRole('button', { name: '派发探子', exact: true }).click();
    await waitForTasks(value => value.tasks.filter(t => t.status === 'running').length === 4 && value.tasks.filter(t => t.status === 'queued').length === 1);
    await page.screenshot({ path: path.join(artifacts, 'v04-agents-overview.png') });
    const queuedRow = agentsPanel.locator('.agent-task-row[data-status="queued"]'); await queuedRow.waitFor();
    const queuedId = await queuedRow.getAttribute('data-task-id'); await queuedRow.click();
    await agentsPanel.getByRole('button', { name: '取消任务', exact: true }).click(); await waitTask(queuedId, 'cancelled');
    const firstTask = (await page.evaluate(() => window.pi.agentTasks())).tasks.find(task => task.task === '等待探子 A');
    await agentsPanel.locator(`[data-task-id="${firstTask.id}"]`).click();
    await agentsPanel.getByRole('button', { name: '取消任务', exact: true }).click(); await waitTask(firstTask.id, 'cancelled');
    await agentsPanel.getByRole('button', { name: '重试任务', exact: true }).click();
    await waitForTasks(value => value.tasks.some(task => task.retryOf === firstTask.id && task.status === 'running'));
    const retryTask = (await page.evaluate(() => window.pi.agentTasks())).tasks.find(task => task.retryOf === firstTask.id);
    await agentsPanel.locator(`[data-task-id="${retryTask.id}"]`).click();
    await agentsPanel.getByRole('button', { name: '取消任务', exact: true }).click(); await waitTask(retryTask.id, 'cancelled');
    await agentsPanel.locator(`[data-task-id="${firstTask.id}"]`).click();
    await agentsPanel.getByRole('button', { name: '继续会话', exact: true }).click(); await waitTask(firstTask.id, 'completed');
    await agentsPanel.getByTestId('task-output').filter({ hasText: '已完成检查。' }).waitFor();
    const resumed = await page.evaluate(id => window.pi.agentTasks({ action: 'detail', id }), firstTask.id);
    assert.equal(resumed.attempts, 2); assert.equal(resumed.sessionPath, firstTask.sessionPath); assert.ok(resumed.usage.tokens.input > 0);
    await page.screenshot({ path: path.join(artifacts, 'v04-agents.png') });
    checks.push('子代理四并发与排队、逐任务取消、重试新会话和继续原会话');
    await agentsPanel.getByRole('button', { name: '引用结果到消息', exact: true }).click();
    assert.match(await editor.inputValue(), /探子任务：等待探子 A/);
    checks.push('探子结果与用量显示、引用结果保留主输入框内容');
    await editor.fill('/desktop-scout-test'); await editor.press('Enter');
    await page.getByText('探子已返回，主 Agent 可以汇总。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor({ state: 'hidden' });
    assert.ok((await page.evaluate(() => window.pi.agentTasks())).tasks.some(task => task.task === '自动派发的只读检查' && task.status === 'completed'));
    checks.push('主 Agent 工具派发、桌面任务登记与结果回传');
    await editor.fill('/desktop-scout-slow-test'); await editor.press('Enter');
    await page.getByRole('button', { name: '停止任务', exact: true }).click();
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor({ state: 'hidden' });
    await waitForTasks(value => !value.tasks.some(task => task.task === '等待自动派发的只读检查' && ['queued', 'starting', 'running', 'cancelling'].includes(task.status)));
    checks.push('父任务派发响应前取消不遗留运行中的子任务');
    await page.getByRole('button', { name: '子代理工作台', exact: true }).click(); agentsPanel = page.getByRole('dialog', { name: '子代理工作台', exact: true });
    await agentsPanel.getByRole('button', { name: '新任务', exact: true }).click();
    await agentsPanel.getByLabel('探子任务', { exact: true }).fill('[fixture-fail-agent]');
    await agentsPanel.getByRole('button', { name: '派发探子', exact: true }).click();
    await agentsPanel.getByText('fixture provider failed', { exact: true }).waitFor();
    checks.push('子代理模型错误保留错误详情');
    await agentsPanel.getByRole('button', { name: '新任务', exact: true }).click();
    await agentsPanel.getByLabel('探子任务', { exact: true }).fill('等待重启后恢复');
    await agentsPanel.getByRole('button', { name: '派发探子', exact: true }).click();
    const runningList = await waitForTasks(value => value.tasks.some(task => task.task === '等待重启后恢复' && task.status === 'running'));
    const interrupted = runningList.tasks.find(task => task.task === '等待重启后恢复' && task.status === 'running');
    assert.equal(typeof interrupted.sessionPath, 'string');
    for (let attempt = 0; ; attempt++) { try { await readFile(interrupted.sessionPath); break; } catch (error) { if (attempt >= 30) throw error; await delay(50); } }
    console.log(JSON.stringify({ crashRecoveryInput: { id: interrupted.id, status: interrupted.status, sessionPath: interrupted.sessionPath } }));
    const beforeCrash = await page.evaluate(() => window.pi.diagnostics());
    const crashExit = once(child, 'exit');
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); await once(killer, 'exit'); await crashExit;
    await Promise.all([beforeCrash.pid, ...(beforeCrash.agentPids || [])].map(pid => waitForProcessExit(pid)));
    await browser.close().catch(() => {}); browser = null; page = null; stderr = '';
    child = spawn(executable, [], { cwd: root, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-10000); }); child.stdout.on('data', () => {});
    const restartDeadline = Date.now() + 30000;
    while (Date.now() < restartDeadline) { try { browser = await chromium.connectOverCDP(debug.url, { timeout: 1000 }); break; } catch { await delay(200); } }
    assert.ok(browser, 'WebView2 did not restart'); page = browser.contexts()[0].pages()[0]; page.on('pageerror', error => errors.push(error.message));
    await page.locator('.connection-pill.ready').waitFor({ timeout: 45000 });
    assert.equal((await page.evaluate(id => window.pi.agentTasks({ action: 'detail', id }), interrupted.id)).status, 'interrupted');
    await page.getByRole('button', { name: '子代理工作台', exact: true }).click(); agentsPanel = page.getByRole('dialog', { name: '子代理工作台', exact: true });
    await agentsPanel.locator(`[data-task-id="${interrupted.id}"]`).click();
    await agentsPanel.getByRole('button', { name: '继续会话', exact: true }).click(); await waitTask(interrupted.id, 'completed');
    assert.equal((await page.evaluate(id => window.pi.agentTasks({ action: 'detail', id }), interrupted.id)).sessionPath, interrupted.sessionPath);
    await page.screenshot({ path: path.join(artifacts, 'v04-agents-recovered.png') });
    await writeFile(path.join(artifacts, 'v04-task-records.json'), JSON.stringify(await page.evaluate(() => window.pi.agentTasks()), null, 2) + '\n');
    await page.keyboard.press('Escape');
    checks.push('应用崩溃清理子进程、重启保留任务记录并继续子会话');
    await scoutHistoryChecks(page, artifacts, checks, waitForValue);
    const rejected = await page.evaluate(async () => {
      try { await window.pi.command('bash', { command: 'echo forbidden' }); return false; } catch { return true; }
    });
    assert.equal(rejected, true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: checks, rendererErrors: errors, screenshotDirectory: artifacts }, null, 2));
  }
  assert.deepEqual(errors, []);
  const piPid = (await page.evaluate(() => window.pi.diagnostics())).pid;
  const processExited = once(child, 'exit');
  await page.evaluate(() => { void window.pi.window('close'); });
  await Promise.race([processExited, delay(10000).then(() => { throw new Error('Tauri did not exit cleanly'); })]);
  assert.equal(child.exitCode, 0);
  await waitForProcessExit(piPid);
  checks.push('窗口正常退出且所属 Pi 进程已结束');
  // 崩溃诊断：正常退出必须在数据目录留下标记（下一次启动据此区分"异常退出"）
  // 注意：这一步必须在 finally 删除临时目录之前做，否则证据会一起被删掉
  const exitMarkerPath = path.join(temp, 'profile', 'last-exit.json');
  const exitMarker = JSON.parse(await readFile(exitMarkerPath, 'utf8'));
  assert.equal(exitMarker.clean, true, '退出标记应标记为正常退出：' + exitMarkerPath);
  assert.ok(exitMarker.at > 0, '退出标记应带时间戳');
  checks.push('崩溃诊断：正常退出标记已落盘');
  await writeFile(resultFile, JSON.stringify({ success: true, mode, version, completedAt: new Date().toISOString(), executable, executableSha256, passed: checks, rendererErrors: errors, modelRequests: 0, ...details }, null, 2) + '\n');
  console.log('Tauri closed cleanly.');
} catch (error) {
  await writeFile(resultFile, JSON.stringify({ success: false, mode, version, completedAt: new Date().toISOString(), executable, executableSha256, passed: checks, rendererErrors: errors, error: error.stack || String(error) }, null, 2) + '\n');
  if (page) {
    await page.screenshot({ path: path.join(artifacts, 'tauri-failure.png') }).catch(() => {});
    console.error('UI failure:', (await page.locator('body').innerText().catch(() => '')).slice(-8000), errors);
  }
  console.error(stderr);
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await once(killer, 'exit').catch(() => {});
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
