// 可自定义快捷键：纯数据 + 纯函数。
// 设计要点：
//   1) 组合键统一归一化成 "Ctrl+Shift+K" 这种形式，修饰键顺序固定，便于比较与显示；
//   2) 只按修饰键（Ctrl/Shift/Alt 单独按下）不构成组合键；
//   3) 逐项校验：非法组合键回落到该动作的默认键，不影响其它自定义。

export const STORAGE_KEY = 'pi-ui-shortcuts';

// 归一化后的修饰键顺序（Meta/Cmd 统一并入 Ctrl，避免 Windows 上出现两套写法）
const MODIFIER_ORDER = ['Ctrl', 'Shift', 'Alt'];

// 单个按键的显示名
const KEY_NAMES = {
  Escape: 'Esc',
  ' ': 'Space',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
};

const LONE_MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Dead']);

// 存储里的写法可能是任意大小写，查表用小写索引
const KEY_ALIASES = new Map(Object.entries(KEY_NAMES).map(([raw, label]) => [raw.toLowerCase(), label]));

export const ACTIONS = [
  { id: 'newSession', label: '新会话', hint: '新建一个对话', def: 'Ctrl+N', scope: '全局' },
  { id: 'openFolder', label: '打开文件夹', hint: '切换工作区', def: 'Ctrl+O', scope: '全局' },
  { id: 'settings', label: '设置与连接', hint: '打开设置对话框', def: 'Ctrl+,', scope: '全局' },
  { id: 'stopTask', label: '停止任务', hint: '中断正在运行的任务（仅在运行时生效）', def: 'Esc', scope: '运行中' },
  { id: 'searchSessions', label: '搜索会话', hint: '聚焦侧栏搜索框', def: 'Ctrl+K', scope: '全局' },
  { id: 'toggleSidebar', label: '切换左栏', hint: '显示或隐藏左侧栏', def: 'Ctrl+B', scope: '全局' },
  { id: 'toggleInspector', label: '切换右栏', hint: '显示或隐藏文件与改动面板', def: 'Ctrl+Shift+B', scope: '全局' },
];

export const actionIds = () => ACTIONS.map(action => action.id);

export const defaultBindings = () => Object.fromEntries(ACTIONS.map(action => [action.id, action.def]));

export const actionOf = id => ACTIONS.find(action => action.id === id) || null;

/** 把一个 KeyboardEvent 形状的对象归一化成组合键；不成组合时返回 null。 */
export function comboFromEvent(event) {
  if (!event || typeof event.key !== 'string') return null;
  const key = event.key;
  if (!key || LONE_MODIFIERS.has(key)) return null;
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  let name = KEY_NAMES[key] || key;
  if (name.length === 1) name = name.toUpperCase();
  return [...parts, name].join('+');
}

/** 校验一个组合键字符串是否可用（用于录制与从存储读取）。 */
export function isValidCombo(combo) {
  if (typeof combo !== 'string') return false;
  const trimmed = combo.trim();
  if (!trimmed) return false;
  const parts = trimmed.split('+');
  if (parts.some(part => !part)) return false;
  const key = parts[parts.length - 1];
  if (LONE_MODIFIERS.has(key) || MODIFIER_ORDER.includes(key)) return false;
  return true;
}

/** 归一化存储里的组合键写法：修饰键顺序统一、大小写统一。 */
export function normalizeCombo(combo) {
  if (!isValidCombo(combo)) return null;
  const parts = combo.trim().split('+');
  const key = parts.pop();
  const modifiers = MODIFIER_ORDER.filter(name => parts.some(part => part.toLowerCase() === name.toLowerCase()));
  const keyName = key.length === 1 ? key.toUpperCase() : (KEY_ALIASES.get(key.toLowerCase()) || key);
  return [...modifiers, keyName].join('+');
}

/** 逐项校验并回落：未知动作丢弃，非法组合键回到默认值。 */
export function resolveBindings(input) {
  const defaults = defaultBindings();
  const out = { ...defaults };
  if (!input || typeof input !== 'object') return out;
  for (const action of ACTIONS) {
    if (!(action.id in input)) continue;
    const normalized = normalizeCombo(input[action.id]);
    if (normalized) out[action.id] = normalized;
  }
  return out;
}

export function readBindings(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return defaultBindings();
    return resolveBindings(JSON.parse(raw));
  } catch {
    return defaultBindings();
  }
}

export function writeBindings(storage, bindings) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(resolveBindings(bindings)));
    return true;
  } catch {
    return false;
  }
}

export function resetBindings(storage) {
  const defaults = defaultBindings();
  writeBindings(storage, defaults);
  return defaults;
}

/** 用一次按键事件查找命中的动作；未命中返回 null。 */
export function matchBinding(bindings, event) {
  const combo = comboFromEvent(event);
  if (!combo) return null;
  for (const action of ACTIONS) {
    if (bindings?.[action.id] === combo) return action.id;
  }
  return null;
}

/** 找出被多个动作占用的组合键。 */
export function findConflicts(bindings) {
  const byCombo = new Map();
  for (const action of ACTIONS) {
    const combo = bindings?.[action.id];
    if (!combo) continue;
    if (!byCombo.has(combo)) byCombo.set(combo, []);
    byCombo.get(combo).push(action.id);
  }
  return [...byCombo.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([combo, ids]) => ({ combo, actions: ids }));
}

/** 只改一个动作：非法组合键或冲突都会被拒绝，返回 { ok, bindings, reason }。 */
export function assignBinding(bindings, actionId, combo, options = {}) {
  const current = resolveBindings(bindings);
  if (!actionOf(actionId)) return { ok: false, bindings: current, reason: '未知动作' };
  const normalized = normalizeCombo(combo);
  if (!normalized) return { ok: false, bindings: current, reason: '这个组合键不可用，请包含至少一个按键' };
  const owner = ACTIONS.find(action => action.id !== actionId && current[action.id] === normalized);
  if (owner && !options.allowConflict) {
    return { ok: false, bindings: current, reason: `该组合键已被「${owner.label}」占用` };
  }
  const next = { ...current, [actionId]: normalized };
  return { ok: true, bindings: next, reason: '' };
}
