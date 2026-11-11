import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PRESET,
  PRESETS,
  STORAGE_KEY,
  applyPresetTo,
  applyStoredPreset,
  changePreset,
  isPreset,
  markerFor,
  presetLabel,
  readStoredPreset,
  resolvePreset,
  storePreset,
} from '../src/ui-theme.mjs';

const fakeStorage = (seed = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  };
};

test('preset list is stable and self-describing', () => {
  assert.equal(PRESETS.length, 3);
  assert.deepEqual(PRESETS.map(preset => preset.id), ['chatgpt', 'cyberpunk', 'classic']);
  for (const preset of PRESETS) {
    assert.ok(preset.label, preset.id);
    assert.ok(preset.note, preset.id);
  }
  assert.equal(DEFAULT_PRESET, 'chatgpt');
});

test('unknown or empty values fall back to the default preset', () => {
  assert.equal(resolvePreset('cyberpunk'), 'cyberpunk');
  assert.equal(resolvePreset(''), DEFAULT_PRESET);
  assert.equal(resolvePreset('nonsense'), DEFAULT_PRESET);
  assert.equal(resolvePreset(null, 'classic'), 'classic');
  assert.equal(resolvePreset('', 'nonsense'), DEFAULT_PRESET);
  assert.equal(isPreset('chatgpt'), true);
  assert.equal(isPreset('nope'), false);
  assert.equal(presetLabel('cyberpunk'), '赛博朋克（原界面）');
  assert.equal(presetLabel('nope'), '未知风格');
});

test('classic maps to no marker so no stylesheet override is loaded', () => {
  assert.equal(markerFor('classic'), '');
  assert.equal(markerFor('chatgpt'), 'chatgpt');
  assert.equal(markerFor('nonsense'), 'chatgpt', '非法值按默认处理');
});

test('applyPresetTo writes or clears the data-ui marker', () => {
  const element = { dataset: {} };
  assert.equal(applyPresetTo(element, 'chatgpt'), true);
  assert.equal(element.dataset.ui, 'chatgpt');
  assert.equal(applyPresetTo(element, 'classic'), true);
  assert.equal('ui' in element.dataset, false, 'classic 应当清掉标记而不是写成空串');
  // 没有 dataset 的元素（例如服务端渲染）不应当抛错
  assert.equal(applyPresetTo(null, 'chatgpt'), false);
  assert.equal(applyPresetTo({}, 'chatgpt'), false);
});

test('storage helpers survive a hostile localStorage', () => {
  const storage = fakeStorage();
  assert.equal(readStoredPreset(storage), '');
  assert.equal(storePreset(storage, 'cyberpunk'), true);
  assert.equal(storage.dump()[STORAGE_KEY], 'cyberpunk');
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readStoredPreset(throwing), '');
  assert.equal(storePreset(throwing, 'chatgpt'), false);
  assert.equal(readStoredPreset(undefined), '');
});

test('apply and change round-trip through storage', () => {
  const storage = fakeStorage();
  const element = { dataset: {} };
  assert.equal(applyStoredPreset(element, storage), DEFAULT_PRESET);
  assert.equal(element.dataset.ui, 'chatgpt');
  assert.equal(changePreset('classic', element, storage), 'classic');
  assert.equal('ui' in element.dataset, false);
  assert.equal(storage.dump()[STORAGE_KEY], 'classic');
  // 重新加载时沿用上次选择
  const reloaded = { dataset: {} };
  assert.equal(applyStoredPreset(reloaded, storage), 'classic');
  assert.equal('ui' in reloaded.dataset, false);
});

test('cyberpunk stylesheet is scoped to its own preset', () => {
  const css = readFileSync(new URL('../src/cyberpunk.css', import.meta.url), 'utf8');
  // 令牌块本身必须带作用域：曾经因为前导注释混进选择器，生成过永远匹配不到的后代选择器。
  assert.match(css, /:root\[data-ui="cyberpunk"\]\s*\{/, '令牌块必须正好是 :root[data-ui="cyberpunk"]');
  const strippedCyber = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const cyberSelectors = [];
  const cyberPattern = /([^{}]+)\{/g;
  let cyberMatch;
  while ((cyberMatch = cyberPattern.exec(strippedCyber)) !== null) {
    const selector = cyberMatch[1].trim();
    if (!selector || selector.startsWith('@')) continue;
    cyberSelectors.push(selector);
  }
  assert.ok(cyberSelectors.length > 40, 'cyberpunk 样式不应为空');
  for (const selector of cyberSelectors) {
    assert.ok(selector.includes(':root[data-ui="cyberpunk"]'), `未受作用域约束的选择器：${selector}`);
    assert.ok(!/\s:root\s*$/.test(selector), `选择器不应以 :root 结尾（说明注释混入了选择器）：${selector}`);
  }
  // 令牌值保持原样，既有对比度测试仍然有效
  assert.match(css, /--accent: #([0-9a-f]{6})/);
  assert.match(css, /color-scheme: dark/);
});

test('preset stylesheet is scoped so it cannot leak into other presets', () => {
  const css = readFileSync(new URL('../src/chatgpt-theme.css', import.meta.url), 'utf8');
  // 每一条规则都必须挂在 data-ui="chatgpt" 下（媒体查询里的规则由内层保证）
  const stripped = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // @keyframes 里的 from/to 是步进选择器，不属于需要作用域约束的规则
    .replace(/@keyframes[\s\S]*?\{[\s\S]*?\{[\s\S]*?\}[\s\S]*?\}/g, '');
  const selectors = [];
  const pattern = /([^{}]+)\{/g;
  let match;
  while ((match = pattern.exec(stripped)) !== null) {
    const selector = match[1].trim();
    if (!selector || selector.startsWith('@')) continue;
    selectors.push(selector);
  }
  assert.ok(selectors.length > 20, '样式文件不应为空');
  for (const selector of selectors) {
    assert.ok(selector.includes('[data-ui="chatgpt"]'), `未受作用域约束的选择器：${selector}`);
  }
  // 令牌集中声明，便于使用者直接调参
  for (const token of ['--bg:', '--sidebar:', '--text:', '--muted:', '--border:', '--accent:', '--column-width:', '--rail-width:']) {
    assert.ok(css.includes(token), `缺少设计变量 ${token}`);
  }
  assert.match(css, /color-scheme: dark/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /forced-colors: active/);
});
