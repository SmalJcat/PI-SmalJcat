import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { textContent } from '../src/transcript.mjs';

const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=' };

async function verifyCopy(page, row, label, text) {
  await page.evaluate(() => {
    window.messageCopyTest = { text: null, fail: false };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => {
        if (window.messageCopyTest.fail) throw new Error('clipboard blocked');
        window.messageCopyTest.text = text;
      },
    } });
  });
  await row.hover();
  const copy = row.getByRole('button', { name: label, exact: true });
  await copy.click();
  await page.waitForFunction(text => window.messageCopyTest.text === text, text);
  assert.equal(await copy.getAttribute('title'), '已复制');
  await page.evaluate(() => { window.messageCopyTest.fail = true; });
  await copy.click();
  await page.waitForFunction(() => !!document.querySelector('button[title="复制失败，请重试"]'));
  await page.evaluate(() => { window.messageCopyTest.fail = false; });
  await copy.click();
  await page.evaluate(() => { delete navigator.clipboard; });
}

export async function piMessageChecks(page, artifacts, checks, waitForValue) {
  const snapshot = () => page.evaluate(() => window.pi.snapshot());
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await page.evaluate(async image => {
    await window.pi.command('set_model', { provider: 'fixture', modelId: 'fixture-model' });
    await window.pi.command('prompt', { message: 'PI_EDIT_ORIGINAL 你好🙂', images: [image] });
  }, image);
  const before = await waitForValue(snapshot, value => !value.state.isStreaming && value.messages.some(message => JSON.stringify(message.content).includes('PI_EDIT_ORIGINAL')));
  const row = page.locator('.message.user').filter({ hasText: 'PI_EDIT_ORIGINAL' });
  await row.getByRole('button', { name: '编辑消息', exact: true }).waitFor();
  await verifyCopy(page, row, '复制用户消息', 'PI_EDIT_ORIGINAL 你好🙂');
  const assistant = page.locator('.message.assistant').filter({ has: page.locator('.markdown') }).last();
  const lastAnswer = before.messages.filter(message => message.role === 'assistant').at(-1);
  await verifyCopy(page, assistant, '复制', textContent(lastAnswer.content));
  await input.fill('普通输入框草稿保留');
  await page.evaluate(image => {
    const original = window.pi.chooseAttachments;
    window.pi.chooseAttachments = async () => {
      window.pi.chooseAttachments = original;
      return [{ ...image, name: 'unsent.png', size: 68 }];
    };
  }, image);
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await row.getByRole('button', { name: '编辑消息', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '编辑消息', exact: true });
  const editor = dialog.getByRole('textbox', { name: '编辑消息内容', exact: true });
  assert.equal(await editor.inputValue(), 'PI_EDIT_ORIGINAL 你好🙂');
  assert.equal(await dialog.getByAltText('原消息图片 1').count(), 1);
  await editor.fill('取消的修改');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await snapshot()).state.sessionId, before.state.sessionId);
  assert.equal(await input.inputValue(), '普通输入框草稿保留');
  await row.getByRole('button', { name: '编辑消息', exact: true }).click();
  await editor.fill('PI_EDIT_REVISED 你好🙂');
  await dialog.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const edited = await waitForValue(snapshot, value => !value.state.isStreaming && value.messages.some(message => JSON.stringify(message.content).includes('PI_EDIT_REVISED')));
  assert.notEqual(edited.state.sessionId, before.state.sessionId);
  assert.ok(!JSON.stringify(edited.messages).includes('PI_EDIT_ORIGINAL'));
  assert.ok((await readFile(before.state.sessionFile, 'utf8')).includes('PI_EDIT_ORIGINAL'));
  const changed = edited.messages.find(message => JSON.stringify(message.content).includes('PI_EDIT_REVISED'));
  assert.deepEqual(changed.content.filter(block => block.type === 'image'), [image]);
  assert.equal(await input.inputValue(), '普通输入框草稿保留');
  assert.equal(await page.locator('.attachment').filter({ hasText: 'unsent.png' }).count(), 1);
  const revised = page.locator('.message.user').filter({ hasText: 'PI_EDIT_REVISED' });
  await revised.hover();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(artifacts, 'v071-message-actions.png') });
  await revised.getByRole('button', { name: '编辑消息', exact: true }).click();
  await editor.fill('[edit-send-fail]');
  await dialog.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'EDIT_SEND_REJECTED' }).waitFor();
  const prepared = await snapshot();
  assert.notEqual(prepared.state.sessionId, edited.state.sessionId);
  assert.equal(await editor.inputValue(), '[edit-send-fail]');
  await editor.fill('PI_EDIT_RETRY');
  await dialog.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const retried = await waitForValue(snapshot, value => !value.state.isStreaming && value.messages.some(message => JSON.stringify(message.content).includes('PI_EDIT_RETRY')));
  assert.equal(retried.state.sessionId, prepared.state.sessionId, 'Retry reuses the prepared branch');
  assert.equal(await input.inputValue(), '普通输入框草稿保留');
  const retryRow = page.locator('.message.user').filter({ hasText: 'PI_EDIT_RETRY' });
  await retryRow.getByRole('button', { name: '编辑消息', exact: true }).click();
  await editor.fill('断线后保留的编辑内容');
  await page.evaluate(() => window.pi.command('prompt', { message: '/crash-test' }));
  await dialog.getByRole('button', { name: '重新连接', exact: true }).click();
  const conflict = page.getByRole('dialog', { name: '会话保护', exact: true });
  const restored = await waitForValue(async () => ({
    snapshot: await snapshot().catch(() => null),
    conflict: await conflict.isVisible(),
  }), value => value.snapshot || value.conflict);
  if (restored.conflict) {
    await conflict.getByRole('button', { name: '复制为新会话', exact: true }).click();
    await conflict.waitFor({ state: 'hidden' });
    await waitForValue(snapshot, value => value.state.sessionId !== retried.state.sessionId);
  }
  assert.equal(await editor.inputValue(), '断线后保留的编辑内容');
  assert.equal(await input.inputValue(), '普通输入框草稿保留');
  await dialog.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await waitForValue(snapshot, value => !value.state.isStreaming && value.messages.some(message => JSON.stringify(message.content).includes('断线后保留的编辑内容')));
  await page.getByRole('button', { name: '移除 unsent.png', exact: true }).click();
  await input.fill('');
  checks.push('Pi 用户消息和助手回复复制及失败反馈；编辑取消、保留图片与独立草稿、原历史分支保留、失败重试复用分支、断线重连保留编辑');
}

export async function acpMessageChecks(page, panel, status, waitForValue, checks) {
  const input = panel.getByRole('textbox', { name: 'Antigravity 消息', exact: true });
  await input.fill('ACP_EDIT_ORIGINAL');
  await input.press('Enter');
  const before = await waitForValue(status, value => !value.busy && value.messages.some(message => JSON.stringify(message).includes('ACP_EDIT_ORIGINAL')));
  const row = panel.locator('.message.user').filter({ hasText: 'ACP_EDIT_ORIGINAL' });
  await verifyCopy(page, row, '复制用户消息', 'ACP_EDIT_ORIGINAL');
  await input.fill('ACP 编辑期间的独立草稿');
  await row.getByRole('button', { name: '编辑为新消息', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑为新消息', exact: true });
  await dialog.getByRole('textbox', { name: '编辑消息内容', exact: true }).fill('ACP_EDIT_REVISED');
  await dialog.getByRole('button', { name: '作为新消息发送', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const after = await waitForValue(status, value => !value.busy && value.messages.some(message => JSON.stringify(message).includes('ACP_EDIT_REVISED')));
  assert.equal(after.sessionId, before.sessionId);
  assert.ok(JSON.stringify(after.messages).includes('ACP_EDIT_ORIGINAL'));
  assert.equal(after.messages.filter(message => message.role === 'user').length, before.messages.filter(message => message.role === 'user').length + 1);
  assert.equal(await input.inputValue(), 'ACP 编辑期间的独立草稿');
  checks.push('ACP 用户消息复制和编辑为新消息，保留原历史和独立草稿');
}
