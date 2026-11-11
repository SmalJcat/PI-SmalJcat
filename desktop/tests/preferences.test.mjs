import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_WIDTHS,
  DEFAULTS,
  DENSITIES,
  FONT_FAMILIES,
  FONT_SCALES,
  MOTIONS,
  RADIUS_SCALES,
  STORAGE_KEY,
  applyPreferences,
  applyStoredPreferences,
  enterSends,
  groupOf,
  isAllowed,
  readPreferences,
  resolvePreferences,
  toCssVariables,
  toDataAttributes,
  toolCardsDefaultOpen,
  updatePreference,
  writePreferences,
} from '../src/preferences.mjs';

const fakeStorage = (seed = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  };
};

const fakeRoot = () => ({ style: { values: {}, setProperty(name, value) { this.values[name] = value; } }, dataset: {} });

test('每个选项组都自洽且默认值合法', () => {
  for (const group of [FONT_SCALES, DENSITIES, FONT_FAMILIES, RADIUS_SCALES, CHAT_WIDTHS, MOTIONS]) {
    assert.ok(group.length >= 2);
    for (const entry of group) {
      assert.ok(entry.id, '缺少 id');
      assert.ok(entry.label, '缺少 label');
      assert.ok(entry.hint, '缺少 hint：' + entry.id);
    }
  }
  const groups = Object.keys(DEFAULTS).filter(key => groupOf(key));
  assert.equal(groups.length, 6, '应当有 6 组可选偏好');
  for (const key of groups) assert.ok(isAllowed(key, DEFAULTS[key]), '默认值非法：' + key);
});

test('非法值逐项回落，不影响其他选择', () => {
  const resolved = resolvePreferences({ fontScale: '9', density: '1.9', motion: 'nope', enterToSend: 'yes' });
  assert.equal(resolved.fontScale, DEFAULTS.fontScale, '非法字号回落');
  assert.equal(resolved.density, '1.9', '合法值保留');
  assert.equal(resolved.motion, DEFAULTS.motion);
  assert.equal(resolved.enterToSend, DEFAULTS.enterToSend, '非布尔值不采用');
  assert.deepEqual(resolvePreferences(null), DEFAULTS);
  assert.deepEqual(resolvePreferences('垃圾输入'), DEFAULTS);
  assert.equal(resolvePreferences({ enterToSend: false }).enterToSend, false);
  assert.equal(resolvePreferences({ collapseTools: true }).collapseTools, true);
});

test('读写存储：损坏数据回落默认值', () => {
  const storage = fakeStorage();
  assert.deepEqual(readPreferences(storage), DEFAULTS);
  assert.equal(writePreferences(storage, { fontScale: '1.14', density: '1.9' }), true);
  const stored = JSON.parse(storage.dump()[STORAGE_KEY]);
  assert.equal(stored.fontScale, '1.14');
  assert.equal(stored.motion, DEFAULTS.motion, '未提供的键写入默认值');
  storage.setItem(STORAGE_KEY, '{坏掉的 json');
  assert.deepEqual(readPreferences(storage), DEFAULTS);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readPreferences(throwing), DEFAULTS);
  assert.equal(writePreferences(throwing, DEFAULTS), false);
});

test('折算成 CSS 变量与 data 标记', () => {
  const preferences = resolvePreferences({ fontScale: '1.07', density: '1.9', radius: '1.4', chatWidth: '900', fontFamily: 'mono', motion: 'reduced', collapseTools: true });
  const vars = toCssVariables(preferences);
  assert.equal(vars['--type-scale'], '1.07');
  assert.equal(vars['--reading-line'], '1.9');
  assert.equal(vars['--radius-scale'], '1.4');
  assert.equal(vars['--chat-width'], '900px');
  const data = toDataAttributes(preferences);
  assert.equal(data.fontFamily, 'mono');
  assert.equal(data.motion, 'reduced');
  assert.equal(data.toolCards, 'collapsed');
  assert.equal(toDataAttributes(DEFAULTS).toolCards, 'collapsed', '默认收起工具卡');
});

test('应用到根元素并可增量更新', () => {
  const storage = fakeStorage();
  const root = fakeRoot();
  const applied = applyStoredPreferences(root, storage);
  assert.deepEqual(applied, DEFAULTS);
  assert.equal(root.style.values['--type-scale'], '1');
  assert.equal(root.dataset.motion, 'full');
  // 增量更新：只改一项，其余保持
  updatePreference(root, storage, 'chatWidth', '640');
  assert.equal(root.style.values['--chat-width'], '640px');
  const after = updatePreference(root, storage, 'radius', '0.5');
  assert.equal(after.radius, '0.5');
  assert.equal(after.chatWidth, '640', '上一次的修改仍在存储里');
  // 非法更新被忽略
  const ignored = updatePreference(root, storage, 'density', '99');
  assert.equal(ignored.density, DEFAULTS.density);
  assert.equal(ignored.chatWidth, '640');
  // 没有 style/dataset 的环境不抛错
  assert.equal(applyPreferences(null, DEFAULTS), null);
  assert.equal(applyPreferences({}, DEFAULTS), null);
});

test('折叠偏好与提交键行为可读', () => {
  const storage = fakeStorage();
  // 默认必须与既有界面行为一致：工具卡收起、Enter 发送
  assert.equal(toolCardsDefaultOpen(storage), false, '默认收起工具卡');
  assert.equal(enterSends(storage), true, '默认 Enter 发送');
  writePreferences(storage, { collapseTools: false, enterToSend: false });
  assert.equal(toolCardsDefaultOpen(storage), true, '关掉折叠偏好后默认展开');
  assert.equal(enterSends(storage), false);
  assert.equal(toolCardsDefaultOpen(undefined), false, '无存储时用默认值');
  assert.equal(enterSends(undefined), true);
});
