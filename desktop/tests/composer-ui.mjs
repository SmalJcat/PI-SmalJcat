import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyComposer(page, checks, artifacts) {
  const editor = page.getByRole('textbox', { name: '消息', exact: true });
  const commands = page.getByRole('listbox', { name: '技能与命令', exact: true });
  const files = page.getByRole('listbox', { name: '文件引用', exact: true });
  const initialCount = await page.locator('.message.user').count();

  await editor.fill('/');
  await commands.getByRole('option').first().waitFor();
  const first = await commands.getByRole('option').first().locator('strong').innerText();
  await editor.press('ArrowUp');
  const last = await commands.getByRole('option').last().locator('strong').innerText();
  assert.equal(await commands.getByRole('option', { selected: true }).locator('strong').innerText(), last);
  await editor.press('ArrowDown');
  assert.equal(await commands.getByRole('option', { selected: true }).locator('strong').innerText(), first);
  await page.screenshot({ path: path.join(artifacts, 'composer-command-menu.png') });
  await editor.press('Tab');
  assert.equal(await editor.inputValue(), `${first} `);
  await commands.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.message.user').count(), initialCount);

  await editor.fill('/conf');
  await commands.getByRole('option').waitFor();
  await editor.press('Enter');
  assert.equal(await editor.inputValue(), '/confirm-test ');
  assert.equal(await page.getByRole('dialog', { name: '是否继续测试？' }).count(), 0);
  await editor.press('Enter');
  await page.getByRole('dialog', { name: '是否继续测试？' }).waitFor();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByRole('dialog', { name: '是否继续测试？' }).waitFor({ state: 'hidden' });
  await editor.fill('/ski');
  await commands.getByRole('option').click();
  assert.equal(await editor.inputValue(), '/skill:review ');
  assert.equal(await editor.evaluate(element => element === document.activeElement), true);
  checks.push('命令菜单上下键循环、Tab/Enter补全、完整命令执行、鼠标选择保持焦点');

  await editor.fill('/conf');
  await commands.waitFor();
  await editor.press('Shift+Enter');
  assert.equal(await editor.inputValue(), '/conf\n');
  await commands.waitFor({ state: 'hidden' });
  await editor.fill('查看 @src/ma');
  await files.getByRole('option').waitFor();
  await editor.press('Shift+Enter');
  assert.equal(await editor.inputValue(), '查看 @src/ma\n');
  assert.equal(await page.getByRole('button', { name: '移除引用 src/main.ts', exact: true }).count(), 0);
  await editor.fill('/conf');
  await commands.waitFor();
  await editor.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true })));
  assert.equal(await editor.inputValue(), '/conf');
  await editor.press('Escape');
  await commands.waitFor({ state: 'hidden' });
  await editor.evaluate(element => element.dispatchEvent(new Event('select', { bubbles: true })));
  assert.equal(await commands.count(), 0);
  checks.push('候选菜单中Shift+Enter换行、中文组词Enter不执行、Esc关闭后不重开');

  // Hold only search responses. Pi and native commands still use the real bridge.
  await page.evaluate(() => {
    const original = window.pi.searchFiles;
    window.completionSearch = { original, pending: {} };
    window.pi.searchFiles = query => {
      if (query.startsWith('delayed')) return new Promise((resolve, reject) => { window.completionSearch.pending[query] = { resolve, reject }; });
      if (query === 'test-empty') return Promise.resolve({ files: [], truncated: false });
      if (query === 'test-error') return Promise.reject(new Error('搜索测试错误'));
      return original(query);
    };
  });
  try {
    await editor.fill('查看 @delayed-old');
    await page.waitForFunction(() => !!window.completionSearch.pending['delayed-old']);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), '查看 @delayed-old');
    assert.equal(await page.locator('.message.user').count(), initialCount);
    await editor.fill('查看 @src/ma');
    await files.getByRole('option').filter({ hasText: 'main.ts' }).waitFor();
    await page.evaluate(() => window.completionSearch.pending['delayed-old'].resolve({ files: [{ path: 'README.md', name: 'README.md', directory: false }], truncated: false }));
    assert.equal(await files.getByRole('option').filter({ hasText: 'README.md' }).count(), 0);
    await editor.press('Tab');
    assert.match(await editor.inputValue(), /@src\/main.ts /);
    await page.getByRole('button', { name: '移除引用 src/main.ts', exact: true }).click();
    await editor.fill('@delayed-error');
    await page.waitForFunction(() => !!window.completionSearch.pending['delayed-error']);
    await editor.fill('普通文字');
    await page.evaluate(() => window.completionSearch.pending['delayed-error'].reject(new Error('过期请求错误')));
    await files.waitFor({ state: 'hidden' });
    assert.equal(await page.getByText('过期请求错误', { exact: false }).count(), 0);
    await editor.fill('@test-empty');
    await page.getByText('没有匹配的文件，可修改关键词或按 Esc 关闭', { exact: true }).waitFor();
    await editor.press('Escape');
    await files.waitFor({ state: 'hidden' });
    await editor.fill('@test-error');
    await page.getByText('文件搜索失败：Error: 搜索测试错误', { exact: true }).waitFor();
    await editor.press('Escape');
    checks.push('文件检索等待不误发、旧结果不覆盖新查询、过期错误丢弃、空结果和失败提示');

    await editor.fill('等待候选菜单测试');
    await editor.press('Enter');
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor();
    await editor.fill('@delayed-running');
    await page.waitForFunction(() => !!window.completionSearch.pending['delayed-running']);
    await editor.press('Escape');
    await files.waitFor({ state: 'hidden' });
    assert.equal((await page.evaluate(() => window.pi.snapshot())).state.isStreaming, true);
    await page.evaluate(() => window.completionSearch.pending['delayed-running'].resolve({ files: [], truncated: false }));
    await editor.fill('/conf');
    await commands.waitFor();
    await editor.press('Escape');
    await commands.waitFor({ state: 'hidden' });
    assert.equal((await page.evaluate(() => window.pi.snapshot())).state.isStreaming, true);
    await editor.press('Escape');
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await page.evaluate(() => window.pi.snapshot())).state.isStreaming, false);
    checks.push('运行中Esc优先关闭等待中的文件菜单或命令菜单，再按Esc才停止任务');
  } finally {
    await page.evaluate(() => { window.pi.searchFiles = window.completionSearch.original; delete window.completionSearch; });
    await editor.fill('');
  }
}
