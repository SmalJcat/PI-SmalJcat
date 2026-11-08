// 界面风格 preset：只切换 documentElement 上的标记，样式细节都在各自的 CSS 文件里。
export const PRESETS = [
  { id: 'chatgpt', label: 'ChatGPT 风格（浅灰深色）', note: '中性深色、圆角胶囊输入台、窄对话列' },
  { id: 'cyberpunk', label: '赛博朋克（原界面）', note: '青紫玻璃质感，保留不变' },
  { id: 'classic', label: '经典反色', note: 'styles.css 的基础配色，不做覆盖' },
];

export const STORAGE_KEY = 'pi-ui-preset';
export const DEFAULT_PRESET = 'chatgpt';

export const isPreset = id => PRESETS.some(preset => preset.id === id);

export const presetLabel = id => PRESETS.find(preset => preset.id === id)?.label || '未知风格';

// classic 表示不加载任何覆盖层，所以它对应的 data-ui 标记是空串。
// 非法值先解析成默认 preset，避免写出一个谁都不匹配的标记（那会静默退回原界面，最难排查）。
export const markerFor = id => {
  const resolved = resolvePreset(id);
  return resolved === 'classic' ? '' : resolved;
};

export function resolvePreset(stored, fallback = DEFAULT_PRESET) {
  if (isPreset(stored)) return stored;
  return isPreset(fallback) ? fallback : DEFAULT_PRESET;
}

export function readStoredPreset(storage) {
  try {
    return storage?.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function storePreset(storage, id) {
  try {
    storage?.setItem(STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}

// 纯函数：把 preset 应用到给定根元素的 dataset 上（便于测试，不直接碰 DOM）。
export function applyPresetTo(element, id) {
  if (!element?.dataset) return false;
  const marker = markerFor(resolvePreset(id));
  if (marker) element.dataset.ui = marker;
  else delete element.dataset.ui;
  return true;
}

// 浏览器入口：读存储 → 解析 → 应用。
export function applyStoredPreset(root = globalThis.document?.documentElement, storage = globalThis.localStorage) {
  const id = resolvePreset(readStoredPreset(storage));
  applyPresetTo(root, id);
  return id;
}

export function changePreset(id, root = globalThis.document?.documentElement, storage = globalThis.localStorage) {
  const next = resolvePreset(id);
  applyPresetTo(root, next);
  storePreset(storage, next);
  return next;
}
