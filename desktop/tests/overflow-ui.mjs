import assert from 'node:assert/strict';
import path from 'node:path';

const luminance = rgb => rgb.slice(0, 3).map(value => {
  const channel = value / 255;
  return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
}).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);

export async function overflowChecks(page, artifacts, checks) {
  const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.ui }));
  await page.evaluate(() => window.pi.command('prompt', { message: '/overflow-test' }));
  const error = page.locator('.inline-error').filter({ hasText: 'OpenAI API error (524)' }).last();
  await error.waitFor();
  const expected = await error.innerText();
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await error.scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => {
      const selectors = ['.inline-error', '.notice', '.message-content', '.conversation-scroll', '.code-block'];
      return selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)).map(element => ({ selector, extra: element.scrollWidth - element.clientWidth })));
    });
    assert.ok(overflow.every(item => item.extra <= 1), JSON.stringify(overflow.filter(item => item.extra > 1)));
    const textBounds = await error.locator('span').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const text = range.getBoundingClientRect(), card = element.parentElement.getBoundingClientRect();
      return { left: text.left, right: text.right, cardLeft: card.left, cardRight: card.right };
    });
    assert.ok(textBounds.left >= textBounds.cardLeft && textBounds.right <= textBounds.cardRight + 1, JSON.stringify(textBounds));
    assert.equal(await error.innerText(), expected, 'Long error must remain complete');
    await page.screenshot({ path: path.join(artifacts, `v052-error-${width}.png`) });
  }
  const model = page.getByLabel('选择模型', { exact: true });
  for (const theme of ['chatgpt', 'cyberpunk', 'classic']) {
    await page.evaluate(theme => { if (theme === 'classic') delete document.documentElement.dataset.ui; else document.documentElement.dataset.ui = theme; }, theme);
    const colors = await model.locator('option').first().evaluate(option => {
      const style = getComputedStyle(option);
      return { foreground: style.color, background: style.backgroundColor };
    });
    const fg = colors.foreground.match(/[\d.]+/g).map(Number), bg = colors.background.match(/[\d.]+/g).map(Number);
    assert.ok(bg.length === 3 || bg[3] === 1, `${theme}: popup needs an opaque background`);
    const l1 = luminance(fg), l2 = luminance(bg);
    assert.ok((Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05) >= 4.5, `${theme}: ${JSON.stringify(colors)}`);
  }
  await page.evaluate(theme => { if (theme) document.documentElement.dataset.ui = theme; else delete document.documentElement.dataset.ui; }, original.theme);
  await model.focus();
  await model.press('Alt+ArrowDown');
  await page.screenshot({ path: path.join(artifacts, 'v052-model-menu.png') });
  await model.press('Escape');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.setViewportSize({ width: original.width, height: original.height });
  checks.push('长 URL/JSON 错误与通知在 1440px/1024px 内完整换行，代码块仅内部滚动');
  checks.push('三种主题原生模型选项具备不透明背景及至少 4.5:1 文字对比度');
}
