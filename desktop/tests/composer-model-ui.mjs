import assert from 'node:assert/strict';
import path from 'node:path';

export async function openModelPanel(page) {
  const trigger = page.getByRole('button', { name: '模型与推理强度', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  const panel = page.getByRole('dialog', { name: '模型与推理设置', exact: true });
  await panel.waitFor();
  return panel;
}

export async function chooseModel(page, key) {
  const panel = await openModelPanel(page);
  const button = panel.getByRole('button', { name: '选择模型', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await panel.locator(`[data-model-key="${key}"]`).click();
  await page.waitForFunction(async expected => { const { state } = await window.pi.snapshot(); return `${state.model.provider}::${state.model.id}` === expected; }, key);
  return panel;
}

export async function composerModelChecks(page, artifacts, checks) {
  let panel = await openModelPanel(page);
  await panel.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.evaluate(() => {
    const original = window.pi.command;
    window.pi.command = async (type, data) => {
      if (type === 'set_model') { window.pi.command = original; throw new Error('fixture model change rejected'); }
      return original(type, data);
    };
  });
  await panel.locator('[data-model-key="fixture::fixture-fast"]').click();
  await page.getByText('fixture model change rejected', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('listbox', { name: '可用模型', exact: true }).isVisible(), true);
  assert.equal((await page.evaluate(() => window.pi.snapshot())).state.model.id, 'fixture-model');
  // Dismiss the transient error after exercising the retry, without losing the picker.
  await panel.getByRole('textbox', { name: '搜索模型', exact: true }).fill('快速');
  assert.equal(await panel.getByRole('option').count(), 1);
  await panel.getByRole('textbox', { name: '搜索模型', exact: true }).press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(async () => (await window.pi.snapshot()).state.model.id === 'fixture-fast');
  assert.equal(await panel.getByRole('slider', { name: '推理强度', exact: true }).isDisabled(), true);
  assert.equal((await page.evaluate(() => window.pi.snapshot())).state.thinkingLevel, 'off');
  panel = await chooseModel(page, 'fixture::fixture-model');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  panel = await openModelPanel(page);
  await panel.getByRole('button', { name: '设为中等推理', exact: true }).click();
  await page.waitForFunction(async () => (await window.pi.snapshot()).state.thinkingLevel === 'medium');
  const slider = panel.getByRole('slider', { name: '推理强度', exact: true });
  await slider.press('Home');
  await page.waitForFunction(async () => (await window.pi.snapshot()).state.thinkingLevel === 'off');
  await slider.press('End');
  await page.waitForFunction(async () => (await window.pi.snapshot()).state.thinkingLevel === 'high');
  const range = await slider.boundingBox();
  await page.mouse.click(range.x + range.width * .35, range.y + range.height / 2);
  await page.waitForFunction(async () => (await window.pi.snapshot()).state.thinkingLevel === 'low');
  await slider.press('End');
  await page.waitForFunction(async () => (await window.pi.snapshot()).state.thinkingLevel === 'high');
  await page.waitForFunction(() => document.querySelector('[aria-label="推理强度"]')?.getAttribute('aria-valuetext') === '高');
  await page.screenshot({ path: path.join(artifacts, 'v053-composer-popup.png') });
  const area = await page.locator('.composer-area').boundingBox(), popup = await panel.boundingBox();
  const x = Math.min(area.x, popup.x), y = Math.min(area.y, popup.y);
  await page.screenshot({ path: path.join(artifacts, 'v053-composer-detail.png'), clip: { x, y, width: Math.max(area.x + area.width, popup.x + popup.width) - x, height: Math.max(area.y + area.height, popup.y + popup.height) - y } });
  const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 1024, height: 640 });
  await panel.getByRole('button', { name: '选择模型', exact: true }).click();
  const inside = await panel.evaluate(element => { const box = element.getBoundingClientRect(); return box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1; });
  assert.ok(inside, 'Model popover must remain inside a small viewport');
  await page.screenshot({ path: path.join(artifacts, 'v053-composer-models-small.png') });
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '模型与推理强度', exact: true }).evaluate(element => document.activeElement === element), true);
  await page.setViewportSize(original);
  const editor = page.getByRole('textbox', { name: '消息', exact: true });
  await editor.fill('等待推理弹层 Escape 测试'); await editor.press('Enter');
  await page.getByRole('button', { name: '停止任务', exact: true }).waitFor();
  panel = await openModelPanel(page);
  assert.equal(await panel.getByRole('slider', { name: '推理强度', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '停止任务', exact: true }).isVisible(), true, 'Escape closes the popover without cancelling the task');
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await page.getByRole('button', { name: '停止任务', exact: true }).waitFor({ state: 'hidden' });
  checks.push('模型搜索/失败重试与键盘选择、非推理模型禁用滑条、鼠标/键盘档位真实保存');
  checks.push('推理弹层在窄窗口不裁切，Escape 关闭并恢复焦点且不误停任务');
}
