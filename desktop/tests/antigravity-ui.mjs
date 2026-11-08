import assert from 'node:assert/strict';
import path from 'node:path';

// Explicit opt-in: connect the packaged desktop to cached official login without a prompt.
export async function officialAntigravityChecks(page, artifacts, checks, waitForValue, waitForProcessExit) {
  await page.getByRole('button', { name: 'Antigravity 会话', exact: true }).click();
  const panel = page.getByRole('main', { name: 'Antigravity 会话', exact: true });
  await panel.waitFor();
  assert.equal(await page.getByRole('main').count(), 1, 'Only the ACP main pane should be visible in the packaged desktop');
  const box = await panel.boundingBox(), sidebar = await page.locator('.sidebar').boundingBox();
  assert.ok(box.x >= sidebar.x + sidebar.width - 1 && box.width > 700 && box.y < 100, JSON.stringify(box));
  await panel.getByRole('button', { name: '连接已有登录', exact: true }).click();
  const status = () => page.evaluate(() => window.pi.antigravity({ action: 'status' }));
  let state = await waitForValue(status, state => state.connected && !state.connecting && state.sessionId, 90000);
  assert.equal(state.agentInfo.name, 'Antigravity ACP Server');
  const modelOption = state.configOptions.find(option => option.category === 'model');
  const available = modelOption.options.flatMap(option => option.options || [option]);
  const chosen = available.find(option => option.value === 'claude-opus-5-5') || available[0];
  await panel.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  const models = page.getByRole('dialog', { name: '模型与推理设置', exact: true });
  await models.getByRole('button', { name: '选择模型', exact: true }).click();
  await models.locator(`[data-model-key="antigravity::${chosen.value}"]`).click();
  state = await waitForValue(status, state => state.configOptions.find(option => option.category === 'model').currentValue === chosen.value);
  await page.keyboard.press('Escape');
  const trigger = panel.getByRole('button', { name: '模型与推理强度', exact: true });
  assert.ok((await trigger.innerText()).includes(chosen.name), 'Selected model is visible without opening the popover');
  const id = state.sessionId, originalPid = state.pid;
  const input = panel.getByRole('textbox', { name: 'Antigravity 消息', exact: true });
  await input.fill('权限切换保留草稿');
  await panel.getByLabel('Antigravity 权限', { exact: true }).selectOption('full-access');
  state = await waitForValue(status, state => state.connected && !state.connecting && state.permissionMode === 'full-access', 90000);
  assert.equal(state.sessionId, id); assert.notEqual(state.pid, originalPid);
  await waitForProcessExit(originalPid);
  assert.equal(await input.inputValue(), '权限切换保留草稿');
  assert.ok((await trigger.innerText()).includes(chosen.name));
  await page.screenshot({ path: path.join(artifacts, 'v061-official-desktop.png') });
  await panel.getByLabel('Antigravity 权限', { exact: true }).selectOption('ask');
  state = await waitForValue(status, state => state.connected && !state.connecting && state.permissionMode === 'ask', 90000);
  assert.equal(state.sessionId, id);
  const pid = state.pid;
  await panel.getByRole('button', { name: '断开', exact: true }).click();
  await waitForValue(status, state => !state.connected);
  await waitForProcessExit(pid);
  await panel.getByRole('button', { name: '返回 Pi', exact: true }).click();
  checks.push('正式桌面连接官方 ACP/已缓存登录、真实模型列表与设置、断开后进程退出（模型请求 0）');
  return { agent: state.agentInfo, selectedModel: chosen.value, models: available.map(option => option.value), modelRequests: 0 };
}

export async function antigravityChecks(page, artifacts, checks, waitForValue, waitForProcessExit) {
  const before = await page.evaluate(() => window.pi.snapshot());
  const piDraft = page.getByRole('textbox', { name: '消息', exact: true });
  await piDraft.fill('Pi 独立草稿');
  await page.getByRole('button', { name: 'Antigravity 会话', exact: true }).click();
  const panel = page.getByRole('main', { name: 'Antigravity 会话', exact: true });
  await panel.getByRole('button', { name: '连接已有登录', exact: true }).click();
  const status = () => page.evaluate(() => window.pi.antigravity({ action: 'status' }));
  let state = await waitForValue(status, state => state.connected && !state.connecting && state.sessionId);
  const id = state.sessionId;
  const input = panel.getByRole('textbox', { name: 'Antigravity 消息', exact: true });
  await input.fill('ACP_UI_TEST [permission]'); await input.press('Enter');
  let permission = page.getByRole('dialog', { name: 'Antigravity 工具权限', exact: true });
  await permission.waitFor();
  assert.ok((await status()).busy);
  assert.equal((await status()).permissions.length, 1, 'Tool permission must wait for the user');
  await permission.getByRole('button', { name: '拒绝', exact: true }).click();
  await waitForValue(status, state => !state.busy && state.permissions.length === 0);
  await panel.locator('.markdown').filter({ hasText: 'ACP_PERMISSION_DENIED' }).first().waitFor();
  await input.fill('ACP_UI_ALLOW [permission]'); await input.press('Enter');
  await permission.waitFor();
  await permission.getByRole('button', { name: '允许一次', exact: true }).click();
  await waitForValue(status, state => !state.busy);
  await panel.locator('.markdown').filter({ hasText: 'ACP_PERMISSION_ALLOWED' }).first().waitFor();
  checks.push('官方 ACP 夹具流式中文、工具显示、权限等待与允许/拒绝');

  await panel.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  let models = page.getByRole('dialog', { name: '模型与推理设置', exact: true });
  await models.getByRole('button', { name: '选择模型', exact: true }).click();
  await models.locator('[data-model-key="antigravity::claude-fixture"]').click();
  await waitForValue(status, state => state.configOptions[0].currentValue === 'claude-fixture');
  await models.getByRole('slider', { name: '推理强度', exact: true }).press('End');
  await waitForValue(status, state => state.configOptions[1].currentValue === 'high');
  await page.keyboard.press('Escape');
  const trigger = panel.getByRole('button', { name: '模型与推理强度', exact: true });
  assert.match(await trigger.innerText(), /Claude fixture\s+高/);
  await input.fill('权限切换保留的草稿');
  await page.evaluate(() => {
    const original = window.pi.chooseAttachments;
    window.pi.chooseAttachments = async () => {
      window.pi.chooseAttachments = original;
      return [{ name: 'draft.png', size: 68, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=' }];
    };
  });
  await panel.getByRole('button', { name: '添加 Antigravity 附件', exact: true }).click();
  await panel.locator('.attachment').filter({ hasText: 'draft.png' }).waitFor();
  const beforePolicy = await status();
  await panel.getByLabel('Antigravity 权限', { exact: true }).selectOption('full-access');
  state = await waitForValue(status, state => state.connected && !state.connecting && state.permissionMode === 'full-access');
  assert.equal(state.sessionId, id); assert.notEqual(state.pid, beforePolicy.pid);
  await waitForProcessExit(beforePolicy.pid);
  assert.deepEqual(state.messages, beforePolicy.messages);
  assert.equal(await input.inputValue(), '权限切换保留的草稿');
  assert.equal(await panel.locator('.attachment').filter({ hasText: 'draft.png' }).count(), 1);
  assert.match(await trigger.innerText(), /Claude fixture\s+高/);
  await page.evaluate(() => {
    const original = window.pi.antigravity;
    window.pi.antigravity = async options => {
      if (options?.action === 'prompt') { window.pi.antigravity = original; throw new Error('ACP_SEND_REJECTED'); }
      return original(options);
    };
  });
  await input.press('Enter');
  await panel.getByRole('alert').filter({ hasText: 'ACP_SEND_REJECTED' }).waitFor();
  assert.equal(await input.inputValue(), '权限切换保留的草稿');
  assert.equal(await panel.locator('.attachment').count(), 1, 'Failed sends preserve attachments');
  await input.fill('FULL_ACCESS_TEST [permission]'); await input.press('Enter');
  state = await waitForValue(status, state => !state.busy && state.messages.some(message => JSON.stringify(message).includes('ACP_IMAGE_COUNT:1')));
  assert.equal(state.permissions.length, 0);
  await page.waitForFunction(() => !document.querySelector('.antigravity-main .attachment'));
  await page.screenshot({ path: path.join(artifacts, 'v061-antigravity.png') });
  await panel.getByLabel('Antigravity 权限', { exact: true }).selectOption('ask');
  await waitForValue(status, state => state.connected && !state.connecting && state.permissionMode === 'ask');
  checks.push('输入栏直接显示当前模型/档位，权限切换真正重启 CLI 且保留会话/配置/草稿/附件；发送失败保留附件');
  await input.fill('Antigravity 独立草稿');
  await panel.getByRole('button', { name: '返回 Pi', exact: true }).click();
  assert.equal(await piDraft.inputValue(), 'Pi 独立草稿');
  const after = await page.evaluate(() => window.pi.snapshot());
  assert.equal(after.state.sessionId, before.state.sessionId); assert.equal(after.state.sessionFile, before.state.sessionFile);
  assert.deepEqual(after.messages, before.messages, 'ACP must never write into Pi transcript');
  await page.getByRole('button', { name: 'Antigravity 会话', exact: true }).click();
  assert.equal(await input.inputValue(), 'Antigravity 独立草稿'); assert.equal((await status()).sessionId, id);
  await panel.getByRole('button', { name: '新会话', exact: true }).click();
  await waitForValue(status, state => state.sessionId && state.sessionId !== id && !state.connecting);
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Antigravity 消息"]').value === '');
  await panel.getByLabel('Antigravity 历史会话', { exact: true }).selectOption(id);
  await waitForValue(status, state => state.sessionId === id && !state.connecting);
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Antigravity 消息"]').value === 'Antigravity 独立草稿');
  await panel.locator('.markdown').filter({ hasText: 'ACP_PERMISSION_ALLOWED' }).first().waitFor();
  checks.push('Antigravity 模型/推理设置、新建/恢复历史、Pi/ACP 草稿和会话隔离');

  await page.evaluate(() => {
    const original = window.pi.antigravity;
    window.pi.antigravity = async options => {
      if (options?.action === 'prompt') {
        window.pi.antigravity = original;
        const result = await original(options); await new Promise(resolve => setTimeout(resolve, 400)); return result;
      }
      return original(options);
    };
  });
  await input.fill('[wait]'); await input.press('Enter');
  await waitForValue(status, state => state.busy);
  assert.equal(await panel.getByLabel('Antigravity 权限', { exact: true }).isDisabled(), true);
  await input.fill('发送期间继续编辑的草稿');
  await panel.getByRole('button', { name: '停止 Antigravity 任务', exact: true }).click();
  await waitForValue(status, state => !state.busy && !state.cancelling);
  await page.waitForFunction(() => !document.querySelector('button[aria-label="发送 Antigravity 消息"]').disabled);
  assert.equal(await input.inputValue(), '发送期间继续编辑的草稿');
  await input.fill('[permission]'); await input.press('Enter');
  await permission.waitFor();
  await permission.getByRole('button', { name: '停止任务', exact: true }).click();
  await waitForValue(status, state => !state.busy && state.permissions.length === 0);
  await permission.waitFor({ state: 'hidden' });
  await input.fill('[long]'); await input.press('Enter');
  await waitForValue(status, state => !state.busy && JSON.stringify(state.messages).includes('ACP_LONG_END'));
  const longMessage = panel.locator('.markdown').filter({ hasText: 'ACP_LONG_END' }).first();
  await longMessage.waitFor();
  assert.equal((await longMessage.innerText()).match(/长输出🙂/g).length, 2048);
  assert.ok(await longMessage.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Long ACP output stays within its message');
  checks.push('ACP 长流式中文/emoji/URL 完整呈现，连续 2048 组内容不丢失、不突破消息宽度');
  const originalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(artifacts, 'v061-antigravity-small.png') });
  const editorBounds = await input.boundingBox(); assert.ok(editorBounds.x >= 0 && editorBounds.x + editorBounds.width <= 1024);
  const toolbar = panel.locator('.composer-toolbar');
  assert.ok(await toolbar.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  const modelBounds = await trigger.boundingBox(), sendBounds = await panel.getByRole('button', { name: '发送 Antigravity 消息', exact: true }).boundingBox();
  assert.ok(Math.abs(modelBounds.y + modelBounds.height / 2 - sendBounds.y - sendBounds.height / 2) < 6);
  await page.setViewportSize(originalViewport);
  state = await status(); const pid = state.pid;
  await panel.getByRole('button', { name: '断开', exact: true }).click();
  await waitForValue(status, state => !state.connected && !state.pid);
  await waitForProcessExit(pid);
  await panel.getByRole('button', { name: '返回 Pi', exact: true }).click();
  assert.equal(await piDraft.inputValue(), 'Pi 独立草稿');
  checks.push('ACP 停止/权限取消、发送回执前编辑保留、窄窗口和受管理进程退出');
}
