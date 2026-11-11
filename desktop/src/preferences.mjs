// 界面偏好：纯数据 + 纯函数，全部可测。
// 取值通过 CSS 变量与 data-* 标记下发，样式层只负责消费（见 typography.css / chatgpt-theme.css）。
// 设计原则：每一项都必须有真实逻辑，不做"点了没反应"的假开关。

export const STORAGE_KEY = 'pi-ui-preferences';

// 字号：整体缩放，作用在排版令牌的使用处（令牌本身保持基准值）
export const FONT_SCALES = [
  { id: '0.93', label: '紧凑', hint: '正文约 13px' },
  { id: '1', label: '标准', hint: '正文 14px' },
  { id: '1.07', label: '宽松', hint: '正文约 15px' },
  { id: '1.14', label: '大', hint: '正文约 16px' },
];

// 阅读密度：只影响中文正文行高（界面行高不动，避免按钮变形）
export const DENSITIES = [
  { id: '1.6', label: '紧凑', hint: '行高 1.6' },
  { id: '1.75', label: '标准', hint: '行高 1.75' },
  { id: '1.9', label: '宽松', hint: '行高 1.9' },
];

// 字体族：均为系统字体组合，不引入自有字体文件
export const FONT_FAMILIES = [
  { id: 'cjk', label: '中文优先', hint: '雅黑 / 苹方 / Noto CJK 依次回退' },
  { id: 'system', label: '系统默认', hint: '跟随系统界面字体' },
  { id: 'mono', label: '等宽', hint: '代码风格，便于对齐' },
  { id: 'serif', label: '衬线', hint: '阅读长文时更传统' },
];

// 圆角：整体缩放圆角令牌
export const RADIUS_SCALES = [
  { id: '0.5', label: '方正', hint: '尽量贴近直角' },
  { id: '1', label: '标准', hint: '与 ChatGPT 一致的圆角' },
  { id: '1.4', label: '圆润', hint: '更柔和的界面' },
];

// 对话列宽：对应它 thread-content-compact / expanded 的取值区间
export const CHAT_WIDTHS = [
  { id: '640', label: '窄', hint: '640px，接近它的紧凑宽度' },
  { id: '768', label: '标准', hint: '768px' },
  { id: '900', label: '宽', hint: '900px，宽屏长代码更友好' },
];

// 动效：完整 / 精简（去掉位移，只留淡入）/ 关闭
export const MOTIONS = [
  { id: 'full', label: '完整', hint: '入场与过渡都保留' },
  { id: 'reduced', label: '精简', hint: '去掉位移与缩放' },
  { id: 'off', label: '关闭', hint: '不做任何动画' },
];

export const DEFAULTS = {
  preset: 'chatgpt',
  fontScale: '1',
  density: '1.75',
  fontFamily: 'cjk',
  radius: '1',
  chatWidth: '768',
  motion: 'full',
  enterToSend: true,
  // 应用既有行为是"工具卡默认收起、点击展开"（src/components.tsx 的 details 无 open 属性），
  // 因此这里默认 true；关掉它才会变成默认展开。
  collapseTools: true,
};

const GROUPS = {
  fontScale: FONT_SCALES,
  density: DENSITIES,
  fontFamily: FONT_FAMILIES,
  radius: RADIUS_SCALES,
  chatWidth: CHAT_WIDTHS,
  motion: MOTIONS,
};

export const groupOf = key => GROUPS[key] || null;

export const isAllowed = (key, value) => {
  const group = GROUPS[key];
  if (group) return group.some(entry => entry.id === String(value));
  if (key === 'enterToSend' || key === 'collapseTools') return typeof value === 'boolean';
  if (key === 'preset') return typeof value === 'string' && value.length > 0;
  return false;
};

// 逐项校验：非法值回落到默认值，不整体丢弃（用户其他选择仍然生效）
export function resolvePreferences(input) {
  const source = input && typeof input === 'object' ? input : {};
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in source)) continue;
    const value = source[key];
    if (key === 'enterToSend' || key === 'collapseTools') {
      if (typeof value === 'boolean') out[key] = value;
      continue;
    }
    if (isAllowed(key, value)) out[key] = String(value);
  }
  return out;
}

export function readPreferences(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return resolvePreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePreferences(storage, preferences) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(resolvePreferences(preferences)));
    return true;
  } catch {
    return false;
  }
}

// 把偏好折算成根元素上的 CSS 变量与 data 标记
export function toCssVariables(preferences) {
  const resolved = resolvePreferences(preferences);
  return {
    '--type-scale': resolved.fontScale,
    '--reading-line': resolved.density,
    '--radius-scale': resolved.radius,
    '--chat-width': resolved.chatWidth + 'px',
  };
}

export const toDataAttributes = preferences => {
  const resolved = resolvePreferences(preferences);
  return { fontFamily: resolved.fontFamily, motion: resolved.motion, toolCards: resolved.collapseTools ? 'collapsed' : 'expanded' };
};

export function applyPreferences(root, preferences) {
  if (!root?.style || !root?.dataset) return null;
  const resolved = resolvePreferences(preferences);
  for (const [name, value] of Object.entries(toCssVariables(resolved))) root.style.setProperty(name, value);
  for (const [name, value] of Object.entries(toDataAttributes(resolved))) root.dataset[name] = value;
  return resolved;
}

export function applyStoredPreferences(root = globalThis.document?.documentElement, storage = globalThis.localStorage) {
  const preferences = readPreferences(storage);
  applyPreferences(root, preferences);
  return preferences;
}

export function updatePreference(root, storage, key, value) {
  const preferences = readPreferences(storage);
  if (key in DEFAULTS && (typeof value === 'boolean' ? typeof value === 'boolean' : isAllowed(key, value))) {
    preferences[key] = typeof value === 'boolean' ? value : String(value);
  }
  const resolved = resolvePreferences(preferences);
  applyPreferences(root, resolved);
  writePreferences(storage, resolved);
  return resolved;
}

// 工具卡的默认展开状态：折叠偏好为真时默认收起
export const toolCardsDefaultOpen = (storage = globalThis.localStorage) => !readPreferences(storage).collapseTools;

// 输入框提交键：true 表示 Enter 发送，false 表示 Ctrl/Cmd+Enter 发送
export const enterSends = (storage = globalThis.localStorage) => readPreferences(storage).enterToSend;
