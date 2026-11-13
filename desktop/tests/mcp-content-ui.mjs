import assert from 'node:assert/strict';
import path from 'node:path';

// Shared by browser fixtures and the native WebView2 -> Rust -> stdio regression.
export async function mcpContentChecks(page, artifacts, checks) {
  await page.getByRole('button', { name: 'MCP 连接', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'MCP 连接', exact: true });
  await dialog.getByRole('tab', { name: '桌面调试', exact: true }).click();
  const content = dialog.locator('.mcp-server').filter({ has: page.getByText('content', { exact: true }) });
  await content.getByRole('button', { name: '连接', exact: true }).click();
  await content.getByRole('button', { name: 'hello', exact: false }).waitFor();
  assert.equal(await content.getByRole('group', { name: 'MCP 能力' }).getByRole('button', { name: '工具', exact: true }).count(), 0);
  await content.locator('.mcp-tool').filter({ hasText: 'hello' }).click();
  assert.equal(await content.getByLabel('资源 URI', { exact: true }).inputValue(), 'fixture://hello');
  await content.getByRole('button', { name: '读取资源', exact: true }).click();
  await content.locator('.mcp-result').filter({ hasText: '你好🙂' }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'mcp-resource.png') });
  await content.getByRole('button', { name: '加载更多资源', exact: true }).click();
  await content.locator('.mcp-tool').filter({ hasText: 'binary' }).click();
  await content.getByRole('button', { name: '读取资源', exact: true }).click();
  await content.locator('.mcp-result').filter({ hasText: '二进制内容' }).waitFor();
  assert.equal(await content.getByRole('button', { name: '加载更多资源', exact: true }).count(), 0);
  await content.getByRole('button', { name: '资源模板列表', exact: true }).click();
  await content.locator('.mcp-tool').filter({ hasText: 'named' }).click();
  await content.getByText('模板：', { exact: false }).waitFor();
  assert.equal(await content.getByRole('button', { name: '读取资源', exact: true }).isDisabled(), true);
  await content.getByRole('button', { name: '加载更多资源模板', exact: true }).click();
  await content.getByLabel('资源 URI', { exact: true }).fill('fixture://hello');
  await content.getByRole('button', { name: '读取资源', exact: true }).click();
  await content.locator('.mcp-result').filter({ hasText: '你好🙂' }).waitFor();
  await content.getByLabel('资源 URI', { exact: true }).fill('fixture://missing');
  await content.getByRole('button', { name: '读取资源', exact: true }).click();
  await content.getByRole('alert').filter({ hasText: 'Resource not found' }).waitFor();
  assert.equal(await content.locator('.mcp-result').count(), 0, 'Failed read clears the previous resource');
  checks.push('MCP 无 tools 服务器连接、资源分页/文本/二进制、模板 URI 读取与错误反馈');

  await content.getByRole('button', { name: '提示词', exact: true }).click();
  await content.locator('.mcp-tool').filter({ hasText: 'greet' }).click();
  const args = content.getByLabel('提示词参数 JSON', { exact: true });
  await args.fill('{}');
  await content.getByRole('button', { name: '获取提示词', exact: true }).click();
  await content.getByRole('alert').filter({ hasText: '缺少必填参数' }).waitFor();
  await args.fill('{"name":42}');
  await content.getByRole('button', { name: '获取提示词', exact: true }).click();
  await content.getByRole('alert').filter({ hasText: '必须是字符串' }).waitFor();
  await args.fill('{"name":"世界"}');
  await content.getByRole('button', { name: '获取提示词', exact: true }).click();
  await content.locator('.mcp-result').filter({ hasText: 'Hello 世界' }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'mcp-prompt.png') });
  await content.getByRole('button', { name: '加载更多提示词', exact: true }).click();
  await content.getByRole('button', { name: '加载更多提示词', exact: true }).waitFor({ state: 'hidden' });
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
    assert.ok(await content.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  }
  checks.push('MCP 提示词分页、必填/字符串参数校验、获取消息与窄窗布局');

  const tools = dialog.locator('.mcp-server').filter({ has: page.getByText('tool-server', { exact: true }) });
  await tools.getByRole('button', { name: '连接', exact: true }).click();
  await tools.locator('.mcp-tool').filter({ hasText: 'echo' }).click();
  await tools.getByLabel('工具参数 JSON').fill('{"text":"tools still work"}');
  await tools.getByRole('button', { name: '调用工具', exact: true }).click();
  await tools.locator('.mcp-result').filter({ hasText: 'tools still work' }).waitFor();
  assert.equal(await content.locator('.mcp-content-panel').count(), 0, 'Switching servers clears the previous content panel');
  await tools.getByRole('button', { name: '断开', exact: true }).click();
  await content.getByRole('button', { name: '断开', exact: true }).click();
  assert.equal(await dialog.locator('.mcp-content-panel').count(), 0);
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  checks.push('MCP 工具调用兼容、服务器切换与断开清理');
}
