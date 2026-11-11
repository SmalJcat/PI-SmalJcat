import assert from 'node:assert/strict';
import path from 'node:path';

// Runs inside the real Tauri/WebView2 fixture acceptance, using no model service.
export async function scoutHistoryChecks(page, artifacts, checks, waitForValue) {
  const created = [];
  for (let index = 0; index < 21; index += 8) {
    const tasks = Array.from({ length: Math.min(8, 21 - index) }, (_, offset) => `history-page-${index + offset}${index + offset === 20 ? ' [fixture-long-agent]' : ''}`);
    const result = await page.evaluate(tasks => window.pi.agentTasks({ action: 'start', tasks }), tasks);
    created.push(...result.tasks.map(task => task.id));
  }
  await waitForValue(() => page.evaluate(() => window.pi.agentTasks()), value => value.active === 0 && created.every(id => value.tasks.some(task => task.id === id && task.status === 'completed')));
  await page.getByRole('button', { name: '子代理工作台', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '子代理工作台', exact: true });
  await panel.getByText('筛选', { exact: true }).click();
  const search = panel.getByLabel('搜索探子任务', { exact: true });
  await search.fill('history-page-');
  await page.waitForFunction(() => document.querySelector('.task-pagination')?.textContent.includes('21 项'));
  assert.equal(await panel.locator('.agent-task-row').count(), 20);
  await panel.getByLabel('下一页任务', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.task-pagination')?.textContent.includes('第 2 / 2 页'));
  assert.equal(await panel.locator('.agent-task-row').count(), 1);
  await search.fill('[fixture-long-agent]');
  await panel.locator(`[data-task-id="${created[20]}"]`).click();
  await panel.getByRole('button', { name: '查看完整结果', exact: true }).click();
  await panel.getByRole('button', { name: '下一页结果', exact: true }).waitFor();
  let output = await panel.getByTestId('task-output').textContent();
  while (await panel.getByRole('button', { name: '下一页结果', exact: true }).isEnabled()) {
    const previous = await panel.locator('.task-output-pages').textContent();
    await panel.getByRole('button', { name: '下一页结果', exact: true }).click();
    await page.waitForFunction(previous => document.querySelector('.task-output-pages')?.textContent !== previous && !document.querySelector('.task-output-pages [role="status"]'), previous);
    output += await panel.getByTestId('task-output').textContent();
  }
  assert.ok(Buffer.byteLength(output) > 128 * 1024);
  assert.ok(output.endsWith('RESULT_END'));
  assert.ok(!output.includes('\ufffd'));
  await page.screenshot({ path: path.join(artifacts, 'scout-history-result.png') });
  const before = await page.evaluate(id => window.pi.agentTasks({ action: 'detail', id }), created[20]);
  await panel.getByRole('button', { name: '归档任务', exact: true }).click();
  await panel.getByText('这里还没有匹配的任务。', { exact: true }).waitFor();
  await panel.getByLabel('筛选归档任务').selectOption('archived');
  await panel.locator(`[data-task-id="${created[20]}"]`).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'scout-history-archive.png') });
  await panel.getByRole('button', { name: '恢复归档任务', exact: true }).click();
  await panel.getByText('这里还没有匹配的任务。', { exact: true }).waitFor();
  await panel.getByLabel('筛选归档任务').selectOption('current');
  await panel.locator(`[data-task-id="${created[20]}"]`).waitFor();
  const after = await page.evaluate(id => window.pi.agentTasks({ action: 'detail', id }), created[20]);
  assert.equal(after.id, before.id); assert.equal(after.sessionPath, before.sessionPath);
  const active = await page.evaluate(() => window.pi.agentTasks({ action: 'start', tasks: ['等待归档保护'] }));
  const id = active.tasks[0].id;
  const rejected = await page.evaluate(async id => {
    const reject = async action => { try { await window.pi.agentTasks({ action, id }); return false; } catch { return true; } };
    return { archive: await reject('archive'), output: await reject('output') };
  }, id);
  assert.deepEqual(rejected, { archive: true, output: true });
  await page.evaluate(id => window.pi.agentTasks({ action: 'cancel', id }), id);
  await waitForValue(() => page.evaluate(id => window.pi.agentTasks({ action: 'detail', id }), id), value => value.status === 'cancelled');
  assert.equal(await page.evaluate(async id => { try { await window.pi.agentTasks({ action: 'archive', id }); return false; } catch { return true; } }, id), true);
  await page.keyboard.press('Escape');
  checks.push('探子历史搜索与分页、完整 Unicode 结果跨页、归档恢复与活跃/恢复数据保护');
}
