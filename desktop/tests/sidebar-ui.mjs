// Deterministic multi-project presentation and interaction checks; no model or user sessions.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const artifacts = 'artifacts/sidebar';
await mkdir(artifacts, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
let browser, page;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CI ? undefined : [
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  ].find(existsSync) });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  const initializeFixture = () => {
    const model = { id: 'fixture', name: 'Fixture', provider: 'local', reasoning: true, input: ['text'], contextWindow: 128000 };
    const projects = ['D:\\PI', 'D:\\BaoKeMeng', 'D:\\modem', 'D:\\rea-main', 'D:\\知识库', 'D:\\ai_control', 'D:\\TorchlightInfinite'];
    const titles = ['检查 Pi 桌面端完成情况', '查看 Pi Desktop 开发进度', '配置 Pi 的 OpenAI 参数', '优化会话搜索与工作区切换', '检查消息复制和编辑行为', '验证一个很长的中文会话标题在侧栏中不会挤压操作按钮或者造成横向滚动', '历史会话'];
    const sessions = projects.flatMap((cwd, group) => Array.from({ length: group ? 2 : 7 }, (_, index) => ({ id: `${group}-${index}`, path: `fixture/${group}-${index}.jsonl`, cwd, name: group ? ['检查项目结构与运行方式', '继续上次的开发任务'][index] : titles[index], updatedAt: Date.now() - index * 60000 })));
    let snapshot = { generation: 1, cwd: projects[0], state: { sessionId: '0-6', sessionName: titles[6], model }, messages: [], models: [model], levels: ['off'], commands: [], stats: {} };
    const listeners = new Set();
    window.sidebarFixture = { sessions, calls: [], emit: event => { for (const listener of listeners) listener({ generation: snapshot.generation, event }); } };
    window.pi = {
      bootstrap: async () => ({ preferences: { executable: 'pi.exe', lastWorkspace: projects[0], recentWorkspaces: projects }, version: '0.7.1', agentDir: 'fixture' }),
      connect: async options => { window.sidebarFixture.calls.push(options); const session = sessions.find(item => item.path === options.sessionPath); snapshot = { ...snapshot, generation: snapshot.generation + 1, cwd: session?.cwd || options.cwd || snapshot.cwd, state: { ...snapshot.state, sessionId: session?.id || '0-6', sessionName: session?.name || titles[6] } }; return snapshot; },
      snapshot: async () => snapshot, sessions: async () => sessions,
      files: async () => [], changes: async () => ({ available: false, files: [] }),
      onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); }, onFileDrop: () => () => {},
      startupReady: async () => ({}), antigravity: async () => ({}),
      sessionAccess: async () => ({ available: true }), sessionSearch: async () => ({ items: [] }),
      revealWorkspace: async cwd => { window.sidebarFixture.openedFolder = cwd; return ''; },
      sessionIndexSync: async () => ({}), diagnostics: async () => ({}), window: async () => {},
    };
  };
  await page.addInitScript(initializeFixture);
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('.connection-pill.ready').waitFor();
  const pi = page.getByRole('region', { name: '项目 PI', exact: true });
  assert.equal(await page.locator('.sidebar-project').count(), 7);
  assert.equal(await pi.locator('.session-item').count(), 6, 'Active older session remains visible beyond the first five');
  await pi.getByRole('button', { name: /显示更多/ }).click();
  assert.equal(await pi.locator('.session-item').count(), 7);
  await pi.locator('.sidebar-session-row').filter({ hasText: '检查 Pi 桌面端完成情况' }).hover();
  await pi.getByRole('button', { name: '置顶 检查 Pi 桌面端完成情况', exact: true }).click();
  await page.getByRole('region', { name: '置顶会话' }).waitFor();
  assert.equal(await pi.locator('.session-item').count(), 6);
  await pi.locator('.project-toggle').click();
  assert.equal(await pi.locator('.session-item').count(), 0);
  await page.reload();
  await page.locator('.connection-pill.ready').waitFor();
  assert.equal(await pi.locator('.session-item').count(), 0, 'Project collapse survives reload');
  assert.equal(await page.locator('.sidebar-pinned .session-item').count(), 1, 'Pinned session survives reload');
  const search = page.getByRole('textbox', { name: '搜索会话', exact: true });
  await search.fill('很长的中文');
  assert.equal(await pi.locator('.session-item').count(), 1, 'Search reveals older matches in collapsed projects');
  await page.getByRole('button', { name: '清空搜索', exact: true }).click();
  assert.equal(await pi.locator('.session-item').count(), 0, 'Clearing search restores collapse');
  await pi.locator('.project-toggle').click();
  const archiveTitle = '检查 Pi 桌面端完成情况';
  const pinnedRegion = page.getByRole('region', { name: '置顶会话' });
  await pinnedRegion.locator('.sidebar-session-row').hover();
  await pinnedRegion.getByRole('button', { name: `归档 ${archiveTitle}`, exact: true }).click();
  await pinnedRegion.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.session-item').filter({ hasText: archiveTitle }).count(), 0);
  await page.reload();
  await page.locator('.connection-pill.ready').waitFor();
  assert.equal(await page.locator('.session-item').filter({ hasText: archiveTitle }).count(), 0, 'Archived session stays hidden after reload');
  await page.getByRole('button', { name: '查看已归档会话', exact: true }).click();
  await pi.locator('.session-item').filter({ hasText: archiveTitle }).waitFor();
  assert.equal(await page.locator('.sidebar-project').count(), 1);
  await pi.locator('.session-item').filter({ hasText: archiveTitle }).click();
  await page.waitForFunction(() => window.sidebarFixture.calls.at(-1)?.sessionPath === 'fixture/0-0.jsonl');
  await page.getByRole('button', { name: '返回项目会话', exact: true }).waitFor();
  await page.screenshot({ path: `${artifacts}/sidebar-archived.png` });
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await page.getByRole('button', { name: '返回项目会话', exact: true }).waitFor();
  await pi.locator('.sidebar-session-row').hover();
  await pi.getByRole('button', { name: `恢复 ${archiveTitle}`, exact: true }).click();
  await page.getByText('暂无已归档会话', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回项目会话', exact: true }).click();
  await pinnedRegion.locator('.session-item').filter({ hasText: archiveTitle }).waitFor();
  await page.locator('.project-scope').click();
  assert.equal(await page.locator('.sidebar-project').count(), 1);
  await page.locator('.project-scope').click();
  await page.getByRole('region', { name: '项目 BaoKeMeng' }).locator('.session-item').first().click();
  await page.waitForFunction(() => window.sidebarFixture.calls.at(-1)?.sessionPath === 'fixture/1-0.jsonl');
  assert.equal(await page.locator('.session-item[aria-current="page"]').count(), 1);
  await page.getByRole('button', { name: '在 modem 中新建会话', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.sidebarFixture.calls.at(-1)?.cwd === 'D:\\modem');
  await page.locator('.connection-pill.ready').waitFor();
  await page.waitForFunction(() => document.querySelector('.breadcrumb > span')?.textContent === 'modem');
  await page.evaluate(() => window.sidebarFixture.emit({ type: 'agent_start' }));
  await page.waitForFunction(() => document.querySelector('.session-item').disabled);
  assert.ok(await page.locator('.project-new:not(.project-options)').evaluateAll(buttons => buttons.every(button => button.disabled)), 'Running task blocks project creation and session switching');
  await page.evaluate(() => window.sidebarFixture.emit({ type: 'agent_settled' }));
  await page.waitForFunction(() => !document.querySelector('.session-item').disabled);
  await pi.locator('.session-item').filter({ hasText: '查看 Pi Desktop 开发进度' }).click();
  await page.locator('.connection-pill.ready').waitFor();
  await page.mouse.move(700, 20);
  for (const size of [{ width: 1440, height: 960 }, { width: 1024, height: 768 }, { width: 900, height: 640 }]) {
    await page.setViewportSize(size);
    const geometry = await page.locator('.sidebar').evaluate(element => {
      const rect = element.getBoundingClientRect(), list = element.querySelector('.sidebar-scroll');
      const settings = element.querySelector('[aria-label="设置与连接"]').getBoundingClientRect();
      return { overflow: element.scrollWidth - element.clientWidth, listOverflow: list.scrollWidth - list.clientWidth, bottom: rect.bottom, settingsBottom: settings.bottom, scrollable: list.scrollHeight > list.clientHeight };
    });
    assert.ok(geometry.overflow <= 1 && geometry.listOverflow <= 1, JSON.stringify(geometry));
    assert.ok(geometry.settingsBottom <= size.height && geometry.bottom <= size.height, JSON.stringify(geometry));
    assert.ok(geometry.scrollable, 'Long project list scrolls independently');
    await page.screenshot({ path: `${artifacts}/sidebar-${size.width}.png` });
    if (size.width === 1440) await page.locator('.sidebar').screenshot({ path: `${artifacts}/sidebar-detail.png` });
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  const openOptions = async name => {
    const button = page.getByRole('button', { name: `项目选项 ${name}`, exact: true });
    await button.scrollIntoViewIfNeeded();
    await button.focus();
    // Keyboard activation follows the focus scroll. Let Chromium deliver that
    // scroll before opening a menu that intentionally dismisses on scrolling.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await button.press('Enter');
    await page.getByRole('menu', { name: `${name} 项目选项`, exact: true }).waitFor();
  };
  await openOptions('modem');
  await page.getByRole('menuitem', { name: '在资源管理器中打开', exact: true }).click();
  assert.equal(await page.evaluate(() => window.sidebarFixture.openedFolder), 'D:\\modem');
  await openOptions('modem');
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('通信项目');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await openOptions('通信项目');
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await page.getByRole('region', { name: '置顶项目', exact: true }).getByRole('region', { name: '项目 通信项目', exact: true }).waitFor();
  await openOptions('通信项目');
  await page.getByRole('menuitem', { name: '分区', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建分区…', exact: true }).click();
  await page.getByLabel('分区名称', { exact: true }).fill('开发中');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await openOptions('通信项目');
  await page.getByRole('menuitem', { name: '取消置顶', exact: true }).click();
  await page.getByRole('region', { name: '开发中', exact: true }).getByRole('region', { name: '项目 通信项目', exact: true }).waitFor();
  await page.reload(); await page.locator('.connection-pill.ready').waitFor();
  await page.getByRole('region', { name: '开发中', exact: true }).getByRole('region', { name: '项目 通信项目', exact: true }).waitFor();
  await openOptions('BaoKeMeng');
  await page.getByRole('menuitem', { name: '分区', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '开发中', exact: true }).click();
  assert.equal(await page.getByRole('region', { name: '开发中', exact: true }).locator('.sidebar-project').count(), 2);
  await openOptions('通信项目');
  await page.getByRole('menuitem', { name: '归档聊天', exact: true }).click();
  await page.getByText('通信项目 · 归档聊天', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回项目会话', exact: true }).click();
  await openOptions('通信项目');
  await page.getByRole('menuitem', { name: '移除项目', exact: true }).click();
  await page.getByRole('dialog', { name: '移除项目' }).getByRole('button', { name: '移除项目', exact: true }).click();
  await page.getByRole('region', { name: '项目 通信项目', exact: true }).waitFor({ state: 'hidden' });
  await page.reload(); await page.locator('.connection-pill.ready').waitFor();
  assert.equal(await page.getByRole('region', { name: '项目 通信项目', exact: true }).count(), 0);
  await page.getByRole('button', { name: '显示已移除项目 · 1', exact: true }).click();
  await openOptions('通信项目');
  await page.getByRole('menuitem', { name: '恢复项目', exact: true }).click();
  await openOptions('通信项目');
  await page.getByRole('menuitem', { name: '分区', exact: true }).click();
  await page.getByRole('menuitem', { name: '管理分区…', exact: true }).click();
  await page.getByLabel('分区名称 开发中', { exact: true }).fill('正在开发');
  await page.getByRole('button', { name: '保存分区', exact: true }).click();
  await page.getByRole('region', { name: '正在开发', exact: true }).waitFor();
  await openOptions('通信项目');
  await page.screenshot({ path: `${artifacts}/project-menu.png` });
  await page.getByRole('menuitem', { name: '分区', exact: true }).click();
  const menuRect = await page.getByRole('menu').boundingBox();
  assert.ok(menuRect.x >= 0 && menuRect.y >= 0 && menuRect.y + menuRect.height <= 768);
  await page.screenshot({ path: `${artifacts}/project-sections.png` });
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '项目选项 通信项目', exact: true }).evaluate(el => el === document.activeElement), true);
  await openOptions('通信项目');
  await page.getByRole('menuitem', { name: '分区', exact: true }).click();
  await page.getByRole('menuitem', { name: '管理分区…', exact: true }).click();
  await page.getByRole('button', { name: '删除 正在开发', exact: true }).click();
  await page.getByRole('button', { name: '保存分区', exact: true }).click();
  assert.equal(await page.getByRole('region', { name: '正在开发', exact: true }).count(), 0);
  assert.equal(await page.locator('.sidebar-project').count(), 7);
  const touchPage = await browser.newPage({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  touchPage.on('pageerror', error => errors.push(error.message));
  await touchPage.addInitScript(initializeFixture);
  await touchPage.goto(server.resolvedUrls.local[0]);
  await touchPage.locator('.connection-pill.ready').waitFor();
  assert.ok(await touchPage.evaluate(() => matchMedia('(hover: none)').matches));
  const touchProject = touchPage.getByRole('region', { name: '项目 PI', exact: true });
  assert.ok(await touchProject.locator('.project-new').evaluateAll(buttons => buttons.length === 2 && buttons.every(button => getComputedStyle(button).opacity === '1')), 'Touch project controls are visible before focus or hover');
  await touchProject.getByRole('button', { name: '项目选项 PI', exact: true }).tap();
  await touchPage.getByRole('menu', { name: 'PI 项目选项', exact: true }).waitFor();
  await touchPage.close();
  assert.deepEqual(errors, []);
  await writeFile(`${artifacts}/result.json`, JSON.stringify({ success: true, errors, checks: ['multi-project grouping', 'active older session', 'show more', 'pin and collapse persistence', 'archive persistence and restore', 'open archived conversation', 'archive view survives sidebar hiding', 'search across collapsed projects', 'current scope', 'session and project actions', 'running guard', '1440/1024/900 geometry', 'project menu open folder / edit / pin', 'sections create move rename delete persistence', 'scoped archive', 'remove and restore persistence', 'menu viewport bounds and Escape focus', 'touch project controls visible and menu opens'] }, null, 2));
  console.log('Sidebar UI checks passed; screenshots: artifacts/sidebar');
} catch (error) {
  await page?.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
  await writeFile(`${artifacts}/result.json`, JSON.stringify({ success: false, errors, error: String(error) }, null, 2));
  throw error;
} finally { try { await browser?.close(); } finally { await server.close(); } }
