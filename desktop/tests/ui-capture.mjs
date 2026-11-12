// UI capture and audit: `npm run ui:capture [-- --only settings --widths 1440x900,1024x768 --themes all]`.
// Launches the test-fixture desktop build with an isolated profile and deterministic Pi/ACP fixtures,
// opens each interface, saves screenshots and runs geometry/style checks. No model calls, no user data.
import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { debugEndpoint, waitForProcessExit } from './tauri-harness.mjs';
import { sourceIdentity, identityFiles } from '../scripts/source-identity.mjs';
import { parseArgs, matchesOnly, freshness, auditPage, renderReport, mergeFindings } from './ui-capture-lib.mjs';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const options = parseArgs(process.argv.slice(2));
const executable = path.join(root, 'src-tauri/target/debug/pi-desktop.exe');
const stampFile = path.join(root, 'src-tauri/target/debug/ui-capture-build.json');
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const log = message => console.log(`[ui-capture] ${message}`);

// ---------------------------------------------------------------- scenarios
// Each scenario prepares its own state, so `--only` works for any subset. Order keeps runs short.
const scenarios = [
  { id: 'home', title: '首页（新会话）', async run(c, shoot) { await c.newSession(); await shoot('home', '首页（新会话）'); } },
  { id: 'chat', title: '对话、思考与工具卡', async run(c, shoot) {
    await c.ensureChat();
    const card = c.page.locator('.tool-card').first();
    if (await card.count()) {
      if (!(await card.evaluate(el => el.open ?? el.querySelector('details')?.open))) await card.locator('summary').first().click();
      await card.scrollIntoViewIfNeeded();
    }
    await shoot('chat', '对话、思考与工具卡');
  } },
  { id: 'slash-menu', title: '斜杠命令菜单', async run(c, shoot) {
    await c.ensureChat();
    await c.editor().fill('/');
    await c.page.getByRole('listbox', { name: '技能与命令', exact: true }).waitFor();
    await shoot('slash-menu', '斜杠命令菜单');
    await c.editor().fill('');
  } },
  { id: 'file-mention', title: '@ 文件引用补全', async run(c, shoot) {
    await c.ensureChat();
    await c.editor().fill('检查 @src/');
    await c.page.getByRole('listbox', { name: '文件引用', exact: true }).waitFor();
    await shoot('file-mention', '@ 文件引用补全');
    await c.editor().fill('');
  } },
  { id: 'model-popover', title: '模型与推理浮层', async run(c, shoot) {
    await c.ensureChat();
    const panel = await c.openModelPanel(c.page);
    await shoot('model-popover', '模型与推理浮层');
    const list = panel.getByRole('button', { name: '选择模型', exact: true });
    if (await list.count() && await list.getAttribute('aria-expanded') !== 'true') await list.click();
    await shoot('model-popover-list', '模型与推理浮层（模型列表）');
    await c.page.keyboard.press('Escape');
  } },
  { id: 'composer-status', title: '权限菜单、自定义规则与上下文信息卡', async run(c, shoot) {
    await c.ensureChat();
    const main = c.page.locator('main.main-area:not(.backend-hidden)').first();
    await main.getByRole('button', { name: 'Pi 上下文用量', exact: true }).click();
    await c.page.getByRole('dialog', { name: 'Pi 上下文信息', exact: true }).waitFor();
    await shoot('context-popover', '上下文用量信息卡');
    await c.page.keyboard.press('Escape');
    await main.getByRole('button', { name: 'Pi 权限', exact: true }).click();
    const menu = c.page.getByRole('menu', { name: 'Pi 权限设置', exact: true });
    await menu.waitFor();
    await shoot('permission-menu', '权限档位菜单');
    await menu.locator('[data-permission-mode="custom"]').click();
    await c.page.getByRole('dialog', { name: 'Pi 自定义权限', exact: true }).waitFor();
    await shoot('permission-custom', '自定义权限规则弹窗');
    await c.closeDialog();
  } },
  { id: 'file-preview', title: '文件预览弹窗', async run(c, shoot) {
    await c.rightTab('文件');
    await c.page.getByRole('button', { name: 'README.md', exact: true }).first().click();
    await c.page.getByRole('dialog').waitFor();
    await shoot('file-preview', '文件预览弹窗');
    await c.closeDialog();
  } },
  { id: 'review', title: '改动列表与差异审阅', async run(c, shoot) {
    await c.rightTab('改动');
    await shoot('review-list', '右栏改动列表');
    await c.page.locator('.change-group').filter({ hasText: '未暂存' }).getByRole('button').first().click();
    await c.page.locator('.split-review').waitFor();
    await shoot('review-diff', '差异审阅（左右对照）');
    await c.closeDialog();
    await c.rightTab('文件');
  } },
  { id: 'search', title: '侧栏会话全文检索', async run(c, shoot) {
    await c.ensureChat();
    const box = c.page.getByLabel('搜索会话');
    await box.fill('中文流式输出');
    await c.page.locator('.content-hit').first().waitFor({ timeout: 30000 });
    await shoot('search', '侧栏会话全文检索');
    await box.fill('');
  } },
  { id: 'session-menu', title: '会话操作菜单', async run(c, shoot) {
    await c.ensureChat();
    const button = c.page.getByRole('button', { name: '会话操作', exact: true });
    await button.click();
    await delay(200);
    await shoot('session-menu', '会话操作菜单');
    if (await c.page.locator('.dropdown-menu').count()) await button.click();
  } },
  { id: 'context', title: '上下文管理', async run(c, shoot) {
    await c.ensureChat();
    await c.openTool('上下文管理');
    await c.page.locator('.context-panel').evaluate(el => { el.scrollTop = 0; }).catch(() => {});
    await shoot('context', '上下文管理');
    await c.closeDialog();
  } },
  { id: 'agents', title: '子代理工作台', async run(c, shoot) {
    await c.openTool('子代理工作台');
    const dialog = c.page.getByRole('dialog', { name: '子代理工作台', exact: true });
    await shoot('agents-empty', '子代理工作台（初始）');
    await dialog.getByRole('button', { name: '新任务', exact: true }).first().click();
    await dialog.getByLabel('探子任务', { exact: true }).fill('检查项目结构并给出摘要');
    await shoot('agents-create', '子代理新建任务');
    await dialog.getByRole('button', { name: '派发探子', exact: true }).click();
    await c.waitFor(() => c.page.evaluate(() => window.pi.agentTasks()), value => value.tasks.some(task => task.status === 'completed'), 30000);
    const row = dialog.locator('.agent-task-row[data-status="completed"]').first();
    if (await row.count()) await row.click();
    await delay(300);
    await shoot('agents-detail', '子代理任务详情与结果');
    await c.closeDialog();
  } },
  { id: 'commands', title: '工作区命令', async run(c, shoot) {
    await c.openTool('工作区命令');
    await shoot('commands', '工作区命令');
    await c.closeDialog();
  } },
  { id: 'mcp', title: 'MCP 连接', async run(c, shoot) {
    await c.page.getByRole('button', { name: 'MCP 连接', exact: true }).click();
    await c.page.getByRole('dialog').waitFor();
    await c.page.locator('.mcp-card').first().waitFor({ timeout: 15000 }).catch(() => {});
    await shoot('mcp-session', 'MCP · Pi 会话');
    const debugTab = c.page.getByRole('tab', { name: '桌面调试', exact: true });
    if (await debugTab.count()) { await debugTab.click(); await delay(300); await shoot('mcp-debug', 'MCP · 桌面调试'); }
    await c.closeDialog();
  } },
  { id: 'settings', title: '设置（全部分区）', async run(c, shoot) {
    await c.page.getByRole('button', { name: /设置与连接/ }).first().click();
    await c.page.getByRole('dialog', { name: '设置与连接', exact: true }).waitFor();
    const nav = c.page.locator('.settings-nav');
    await nav.waitFor();
    const sections = (await nav.getByRole('button').allInnerTexts()).map(text => text.trim()).filter(Boolean);
    for (const [index, name] of sections.entries()) {
      await nav.getByRole('button', { name, exact: true }).click();
      await delay(250);
      await c.page.locator('.settings-content').evaluate(el => { el.scrollTop = 0; }).catch(() => {});
      await shoot(`settings-${String(index + 1).padStart(2, '0')}`, `设置 · ${name}`);
    }
    await c.closeDialog();
  } },
  { id: 'long-error', title: '长错误与通知', async run(c, shoot) {
    await c.ensureChat();
    await c.page.evaluate(() => window.pi.command('prompt', { message: '/overflow-test' }));
    const error = c.page.locator('.inline-error').filter({ hasText: 'OpenAI API error (524)' }).last();
    await error.waitFor();
    await error.scrollIntoViewIfNeeded();
    await shoot('long-error', '长错误与通知');
    const dismiss = c.page.getByRole('button', { name: '关闭提示', exact: true });
    for (let i = 0; i < 3 && await dismiss.count(); i++) await dismiss.first().click().catch(() => {});
  } },
  { id: 'antigravity', title: 'Antigravity 后端', async run(c, shoot) {
    const page = c.page;
    await page.getByRole('button', { name: 'Antigravity 会话', exact: true }).click();
    const panel = page.getByRole('main', { name: 'Antigravity 会话', exact: true });
    await panel.waitFor();
    const status = () => page.evaluate(() => window.pi.antigravity({ action: 'status' }));
    const connect = panel.getByRole('button', { name: '连接已有登录', exact: true });
    if (await connect.count()) {
      await shoot('antigravity-connect', 'Antigravity 连接前');
      await connect.click();
    }
    await c.waitFor(status, state => state.connected && !state.connecting && state.sessionId, 30000);
    await shoot('antigravity-empty', 'Antigravity 空会话');
    const input = panel.getByRole('textbox', { name: 'Antigravity 消息', exact: true });
    await input.fill('界面巡检 [permission]');
    await input.press('Enter');
    const permission = page.getByRole('dialog', { name: 'Antigravity 工具权限', exact: true });
    await permission.waitFor();
    await shoot('antigravity-permission', 'Antigravity 工具权限确认');
    await permission.getByRole('button', { name: '允许一次', exact: true }).click();
    await c.waitFor(status, state => !state.busy, 30000);
    await input.fill('长输出 [long]');
    await input.press('Enter');
    await c.waitFor(status, state => !state.busy, 30000);
    await shoot('antigravity-chat', 'Antigravity 对话（长输出）');
    const pid = (await status()).pid;
    await panel.getByRole('button', { name: '断开', exact: true }).click().catch(() => {});
    await c.waitFor(status, state => !state.connected, 15000).catch(() => {});
    if (pid) await waitForProcessExit(pid).catch(() => {});
    await panel.getByRole('button', { name: '返回 Pi', exact: true }).click().catch(() => {});
  } },
];

if (options.list) {
  for (const scenario of scenarios) console.log(`${scenario.id.padEnd(16)} ${scenario.title}`);
  process.exit(0);
}
const selected = scenarios.filter(scenario => matchesOnly(options.only, scenario.id) || options.only.some(filter => filter.startsWith(`${scenario.id}-`)));
if (!selected.length) throw new Error(`--only 未匹配任何场景；可用：${scenarios.map(s => s.id).join(', ')}`);

// ---------------------------------------------------------------- build freshness
async function newestSourceMtime() {
  let newest = 0;
  for (const name of await identityFiles(root)) {
    try { newest = Math.max(newest, (await stat(path.join(root, name))).mtimeMs); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return newest;
}
async function readBuildState(source) {
  let exeSha = '', exeMtimeMs = NaN, stamp = null;
  try { exeSha = await sha256(executable); exeMtimeMs = (await stat(executable)).mtimeMs; } catch {}
  try { stamp = JSON.parse(await readFile(stampFile, 'utf8')); } catch {}
  return { exeSha, ...freshness({ stamp, sourceSha: source.sha256, exeSha, exeMtimeMs, newestSourceMtimeMs: stamp ? NaN : await newestSourceMtime() }) };
}
async function build() {
  log('构建测试程序：npm run build:test（首次可能需要几分钟）');
  const child = spawn('npm run build:test', { cwd: root, shell: true, stdio: 'inherit', windowsHide: true });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`build:test 失败，退出码 ${code}`);
}

let source = await sourceIdentity(root);
let buildState = await readBuildState(source);
let rebuilt = false;
if (options.build === 'always' || (options.build === 'auto' && !buildState.fresh)) {
  if (!buildState.fresh) log(`测试程序需要重建：${buildState.reason}`);
  await build();
  const after = await sourceIdentity(root);
  if (after.sha256 !== source.sha256) log('警告：构建期间源码发生变化，截图可能对应构建开始时的源码');
  source = after;
  const exeSha = await sha256(executable);
  await writeFile(stampFile, JSON.stringify({ source: source.sha256, exe: exeSha, commit: source.commit, dirty: source.dirty, builtAt: new Date().toISOString() }, null, 2) + '\n');
  buildState = { exeSha, fresh: true, reason: '本次构建' };
  rebuilt = true;
} else if (!buildState.fresh) {
  log(`警告：${buildState.reason}；按 --no-build 继续，截图可能不是最新界面`);
} else if (buildState.reason.includes('修改时间')) {
  await writeFile(stampFile, JSON.stringify({ source: source.sha256, exe: buildState.exeSha, commit: source.commit, dirty: source.dirty, builtAt: null, inferred: true }, null, 2) + '\n');
}
log(`构建判定：${buildState.fresh ? '最新' : '可能过期'}（${buildState.reason}）`);

try {
  const { stdout } = await exec('whoami', ['/groups'], { windowsHide: true });
  if (/High Mandatory Level/i.test(stdout)) log('警告：当前为管理员（高完整性）进程，WebView2 可能无法正常启动；请在普通权限终端运行');
} catch {}

// ---------------------------------------------------------------- isolated launch
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const now = new Date();
const stampText = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const out = path.resolve(root, options.out || path.join('artifacts', 'ui-capture', stampText));
await mkdir(out, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-ui-capture-'));
const work = path.join(temp, '示例项目');
await mkdir(path.join(work, 'src'), { recursive: true });
await writeFile(path.join(work, 'README.md'), '# Pi Desktop 测试项目\n\n这是文件预览内容。');
await writeFile(path.join(work, 'src/main.ts'), 'export const ready = true;\n');
const git = args => exec('git', args, { cwd: work, windowsHide: true });
await git(['init']); await git(['add', '.']);
await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
await writeFile(path.join(work, 'src/main.ts'), 'export const ready = false;\n'); await git(['add', '.']);
await writeFile(path.join(work, 'src/main.ts'), 'export const ready = "working";\n');

const debug = await debugEndpoint();
const env = { ...process.env, PI_DESKTOP_USER_DATA: path.join(temp, 'profile'), PI_DESKTOP_WORKSPACE: work, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: debug.args, PI_DESKTOP_TEST: '1', PI_CODING_AGENT_DIR: path.join(temp, 'agent') };
delete env.PI_DESKTOP_DEBUG_PORT; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [], { cwd: root, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8000); });
child.stdout.on('data', () => {});

const manifest = { capturedAt: new Date().toISOString(), version, source, executable: path.relative(root, executable), build: { ...buildState, rebuilt }, viewports: options.viewports, themes: options.themes, captures: [], failures: [], rendererErrors: [] };
let browser, page;
try {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !browser) {
    if (child.exitCode !== null) throw new Error(`桌面程序提前退出：${child.exitCode}\n${stderr}`);
    try { browser = await chromium.connectOverCDP(debug.url, { timeout: 1000 }); } catch { await delay(250); }
  }
  if (!browser) throw new Error(`无法连接 WebView2 调试端口\n${stderr}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] || await context.waitForEvent('page');
  page.on('pageerror', error => manifest.rendererErrors.push(error.message));
  await page.locator('.connection-pill.ready').waitFor({ timeout: 45000 });
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.ui || 'classic');

  const c = {
    page,
    editor: () => page.getByRole('textbox', { name: '消息', exact: true }),
    async waitFor(read, predicate, timeout = 20000) {
      const end = Date.now() + timeout; let last;
      while (Date.now() < end) { last = await read(); if (predicate(last)) return last; await delay(150); }
      throw new Error(`等待界面状态超时：${JSON.stringify(last)?.slice(0, 300)}`);
    },
    async newSession() {
      if (await page.locator('.welcome').isVisible().catch(() => false)) return;
      await page.getByRole('button', { name: /新会话/ }).first().click();
      await page.locator('.welcome').waitFor();
    },
    async ensureChat() {
      if (await page.locator('.message.assistant').count()) return;
      await c.editor().fill('你好，请检查项目');
      await c.editor().press('Enter');
      await page.getByText('已完成检查。', { exact: true }).first().waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: '停止任务', exact: true }).waitFor({ state: 'hidden' });
    },
    async openModelPanel() {
      const trigger = page.getByRole('button', { name: '模型与推理强度', exact: true }).first();
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
      const panel = page.getByRole('dialog', { name: '模型与推理设置', exact: true });
      await panel.waitFor();
      return panel;
    },
    async openTool(label) {
      await page.getByRole('button', { name: label, exact: true }).first().click();
      await page.getByRole('dialog').first().waitFor();
      await delay(250);
    },
    async closeDialog() {
      const close = page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true });
      if (await close.count()) await close.first().click(); else await page.keyboard.press('Escape');
      await page.locator('[role="dialog"][aria-modal="true"]').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    },
    async rightTab(name) {
      if (!await page.locator('.inspector').isVisible().catch(() => false)) {
        await page.getByRole('button', { name: '文件与改动', exact: true }).first().click();
        await page.locator('.inspector').waitFor();
      }
      await page.locator('.inspector .panel-tabs button').filter({ hasText: new RegExp(`^${name}`) }).first().click();
      await delay(200);
    },
  };

  async function resetUi() {
    for (let i = 0; i < 3; i++) {
      if (!await page.locator('[role="dialog"]').count()) break;
      await page.keyboard.press('Escape'); await delay(150);
    }
    await page.setViewportSize(options.viewports[0]);
  }

  for (const scenario of selected) {
    const groups = [];
    const shoot = async (id, title) => {
      if (!matchesOnly(options.only, id) && !matchesOnly(options.only, scenario.id)) return;
      const shots = [];
      for (const viewport of options.viewports) {
        await page.setViewportSize(viewport);
        for (const theme of options.themes) {
          await page.evaluate(theme => { if (theme === 'classic') delete document.documentElement.dataset.ui; else document.documentElement.dataset.ui = theme; }, theme);
          await delay(350);
          const variant = `${viewport.width}x${viewport.height}${options.themes.length > 1 || theme !== 'chatgpt' ? `-${theme}` : ''}`;
          const file = `${id}@${variant}.png`;
          const audit = options.audit ? await page.evaluate(auditPage) : { findings: [], stats: {} };
          await page.screenshot({ path: path.join(out, file), animations: 'disabled' });
          shots.push({ variant, file, findings: audit.findings, stats: audit.stats });
        }
      }
      await page.evaluate(theme => { if (theme === 'classic') delete document.documentElement.dataset.ui; else document.documentElement.dataset.ui = theme; }, originalTheme);
      await page.setViewportSize(options.viewports[0]);
      await delay(150);
      groups.push({ id, title, shots });
      const issues = mergeFindings(shots).filter(item => item.type !== 'small-text' && item.type !== 'small-target').length;
      log(`✓ ${id}（${shots.length} 张${issues ? `，${issues} 项需关注` : ''}）`);
    };
    try {
      await scenario.run(c, shoot);
    } catch (error) {
      const file = `FAILED-${scenario.id}.png`;
      await page.screenshot({ path: path.join(out, file) }).catch(() => {});
      manifest.failures.push({ id: scenario.id, error: String(error.message || error).split('\n')[0].slice(0, 400), screenshot: file });
      log(`✗ ${scenario.id}：${String(error.message || error).split('\n')[0]}`);
      await resetUi().catch(() => {});
    }
    manifest.captures.push(...groups);
  }

  const pid = (await page.evaluate(() => window.pi.diagnostics())).pid;
  const exited = once(child, 'exit');
  await page.evaluate(() => { void window.pi.window('close'); });
  await Promise.race([exited, delay(10000)]);
  if (pid) await waitForProcessExit(pid).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await once(killer, 'exit').catch(() => {});
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(out, 'REPORT.md'), renderReport(manifest));
  await mkdir(path.join(root, 'artifacts', 'ui-capture'), { recursive: true });
  await writeFile(path.join(root, 'artifacts', 'ui-capture', 'latest.json'), JSON.stringify({ dir: out, report: path.join(out, 'REPORT.md'), capturedAt: manifest.capturedAt, version, commit: source.commit, dirty: source.dirty, fresh: manifest.build.fresh }, null, 2) + '\n');
  const shots = manifest.captures.reduce((sum, group) => sum + group.shots.length, 0);
  log(`完成：${manifest.captures.length} 个界面、${shots} 张截图、${manifest.failures.length} 个失败场景、渲染错误 ${manifest.rendererErrors.length} 条`);
  log(`报告：${path.join(out, 'REPORT.md')}`);
}
if (manifest.failures.length) process.exitCode = 1;
