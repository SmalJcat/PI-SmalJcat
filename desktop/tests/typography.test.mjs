import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/typography.css', import.meta.url), 'utf8');

const token = name => {
  const match = css.match(new RegExp('--' + name + ':\\s*([^;]+);'));
  assert.ok(match, '缺少排版令牌 --' + name);
  return match[1].trim();
};

test('排版令牌覆盖字号、行高、字重与字距', () => {
  for (const size of ['display', 'title', 'subtitle', 'body', 'label', 'meta', 'micro', 'code']) {
    assert.match(token('type-' + size + '-size'), /^\d+(\.\d+)?px$/, size);
  }
  for (const line of ['ui', 'cjk', 'code', 'display']) {
    assert.match(token('type-' + line + '-line'), /^[\d.]+$/, line);
  }
  for (const weight of ['regular', 'medium', 'strong']) {
    assert.match(token('type-weight-' + weight), /^[0-9]{3}$/, weight);
  }
});

test('中文正文行高必须明显大于英文界面行高', () => {
  const ui = Number(token('type-ui-line'));
  const cjk = Number(token('type-cjk-line'));
  assert.ok(cjk > ui, '中文行高应大于界面行高：' + cjk + ' vs ' + ui);
  assert.ok(cjk >= 1.7, '中文正文行高至少 1.7，实测 ' + cjk);
  assert.ok(Number(token('type-code-line')) >= 1.6);
});

test('中文标题不用重字重，也不加负字距', () => {
  assert.equal(token('type-tracking-cjk'), '0', '中文默认字距必须为 0');
  assert.ok(Number(token('type-weight-medium')) <= 500, '标题用 500 而非 600');
  // 负字距只允许出现在大字号显示文本上，且必须很轻
  const display = Number(token('type-tracking-display').replace('em', ''));
  assert.ok(display < 0 && display >= -0.02, '显示字距应轻微：' + display);
});

test('字体栈包含中文字体回退与等宽字体', () => {
  const ui = token('font-ui');
  for (const family of ['Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans CJK SC', 'sans-serif']) {
    assert.ok(ui.includes(family), '界面字体栈缺少 ' + family);
  }
  const code = token('font-code');
  for (const family of ['Cascadia Code', 'Consolas', 'monospace']) {
    assert.ok(code.includes(family), '等宽字体栈缺少 ' + family);
  }
});

test('排版规则全部受 preset 作用域约束', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  const pattern = /([^{}]+)\{/g;
  let match;
  while ((match = pattern.exec(stripped)) !== null) {
    const selector = match[1].trim();
    if (!selector || selector.startsWith('@')) continue;
    selectors.push(selector);
  }
  assert.ok(selectors.length > 10, '排版文件不应为空');
  for (const selector of selectors) {
    assert.ok(selector.includes('[data-ui="chatgpt"]'), '未受作用域约束：' + selector);
  }
  // 关闭合成字重，避免中文伪粗体
  assert.match(css, /font-synthesis:\s*none/);
  // 数字用等宽
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
});
