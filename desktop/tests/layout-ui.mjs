import assert from 'node:assert/strict';
import path from 'node:path';

export async function layoutChecks(page, artifacts, checks) {
  const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const geometry = () => page.locator('.workspace-tools button').evaluateAll(buttons => buttons.map(button => {
    const { x, y, width, height } = button.getBoundingClientRect();
    return { x, y, width, height };
  }));
  const close = () => page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
  const bounds = () => page.getByRole('dialog').evaluate(element => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight, overflow: element.scrollWidth - element.clientWidth };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.welcome').waitFor();
  const before = await geometry();
  assert.equal(before.length, 4);
  assert.ok(before.every((rect, index) => rect.height >= 32 && rect.x === before[0].x && (index === 0 || rect.y >= before[index - 1].y + before[index - 1].height)), 'Cold navigation is a stable vertical list');
  const welcome = await page.locator('.welcome').boundingBox(), composer = await page.locator('.composer-context:visible').boundingBox();
  assert.ok(composer.y >= welcome.y + welcome.height - 1 && composer.y - welcome.y - welcome.height < 48, 'Welcome and composer stay adjacent');
  await page.getByRole('button', { name: 'Antigravity 会话', exact: true }).click();
  const acp = page.getByRole('main', { name: 'Antigravity 会话', exact: true });
  await acp.waitFor();
  assert.equal(await page.getByRole('main').count(), 1, 'The empty Pi welcome must not override backend visibility');
  assert.equal(await page.locator('.welcome').isVisible(), false);
  const acpBox = await acp.boundingBox(), sidebar = await page.locator('.sidebar').boundingBox();
  assert.ok(acpBox.x >= sidebar.x + sidebar.width - 1 && acpBox.width > 700 && acpBox.y < 100, JSON.stringify(acpBox));
  await acp.getByRole('button', { name: '返回 Pi', exact: true }).click();
  await page.locator('.welcome').waitFor();
  assert.equal(await page.getByRole('main').count(), 1);
  checks.push('空 Pi 会话切换 Antigravity 只显示一个主区，返回后欢迎页恢复');
  await page.screenshot({ path: path.join(artifacts, 'v051-home.png') });
  for (const label of ['子代理工作台', '上下文管理']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.locator('.workspace-panel').waitFor();
    if (label === '子代理工作台') {
      const dialog = page.getByRole('dialog');
      assert.equal(await dialog.getByLabel('探子任务', { exact: true }).count(), 0);
      await dialog.getByRole('button', { name: '新任务', exact: true }).click();
      await dialog.getByLabel('探子任务', { exact: true }).fill('保留未派发的草稿');
      assert.equal(await dialog.getByLabel('探子模型', { exact: true }).isVisible(), false);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await dialog.getByRole('button', { name: '新任务', exact: true }).click();
      assert.equal(await dialog.getByLabel('探子任务', { exact: true }).inputValue(), '保留未派发的草稿');
      await page.screenshot({ path: path.join(artifacts, 'v051-agent-create.png') });
    }
    await close();
    assert.deepEqual(await geometry(), before, `${label} must not shift persistent navigation`);
  }
  checks.push('冷启动导航与首次打开/关闭懒加载面板后几何一致；首页输入框相邻');
  checks.push('子代理先看列表、新任务显式展开、高级选项折叠且取消保留草稿');

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('button', { name: '设置与连接', exact: true }).click();
  await page.locator('.settings-nav-group').first().waitFor();
  assert.equal(await page.locator('.settings-nav-group').count(), 3);
  const nav = page.locator('.settings-nav');
  await nav.getByRole('button', { name: '外观', exact: true }).click();
  let box = await bounds();
  assert.ok(box.x >= 0 && box.y >= 0 && box.right <= box.width + 1 && box.bottom <= box.height + 1 && box.overflow <= 1, JSON.stringify(box));
  const content = await page.locator('.settings-content').boundingBox();
  assert.ok(content.y + content.height <= box.bottom + 1, 'Settings scroll area stays inside the dialog');
  await page.screenshot({ path: path.join(artifacts, 'v051-settings-small.png') });
  await nav.getByRole('button', { name: 'MCP', exact: true }).click();
  await page.getByRole('tab', { name: '桌面调试', exact: true }).click();
  await page.getByText('桌面 MCP 调试', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Pi 会话', exact: true }).click();
  await page.getByRole('button', { name: '刷新状态', exact: true }).waitFor();
  await close();
  await page.getByRole('button', { name: '工作区命令', exact: true }).click();
  await page.getByRole('dialog', { name: '工作区命令' }).waitFor();
  await page.getByText('非交互命令', { exact: true }).waitFor();
  await close();
  checks.push('1024px 窗口设置分组可达、MCP 会话/调试切换及命令入口');
  await page.setViewportSize(original);
}
