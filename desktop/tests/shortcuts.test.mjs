import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS,
  STORAGE_KEY,
  actionIds,
  assignBinding,
  comboFromEvent,
  defaultBindings,
  findConflicts,
  isValidCombo,
  matchBinding,
  normalizeCombo,
  readBindings,
  resetBindings,
  resolveBindings,
  writeBindings,
} from '../src/shortcuts.mjs';

const fakeStorage = (seed = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  };
};

const event = overrides => ({ key: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...overrides });

test('动作表自洽且默认键合法唯一', () => {
  assert.ok(ACTIONS.length >= 6);
  for (const action of ACTIONS) {
    assert.ok(action.id && action.label && action.hint && action.scope, action.id);
    assert.ok(isValidCombo(action.def), '默认键非法：' + action.id);
  }
  assert.equal(findConflicts(defaultBindings()).length, 0, '默认键不应冲突');
  assert.equal(new Set(actionIds()).size, ACTIONS.length);
});

test('按键归一化：修饰键顺序固定、字母大写、Meta 并入 Ctrl', () => {
  assert.equal(comboFromEvent(event({ key: 'k', ctrlKey: true })), 'Ctrl+K');
  assert.equal(comboFromEvent(event({ key: 'K', metaKey: true })), 'Ctrl+K', 'Cmd 与 Ctrl 归一');
  assert.equal(comboFromEvent(event({ key: 'b', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+B');
  assert.equal(comboFromEvent(event({ key: 'x', altKey: true, ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Alt+X');
  assert.equal(comboFromEvent(event({ key: 'Escape' })), 'Esc');
  assert.equal(comboFromEvent(event({ key: ' ' })), 'Space');
  assert.equal(comboFromEvent(event({ key: 'ArrowUp' })), '↑');
  assert.equal(comboFromEvent(event({ key: ',' , ctrlKey: true })), 'Ctrl+,');
});

test('只按修饰键不成组合', () => {
  for (const key of ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock']) {
    assert.equal(comboFromEvent(event({ key })), null, key);
  }
  assert.equal(comboFromEvent(null), null);
  assert.equal(comboFromEvent({}), null);
  assert.equal(isValidCombo('Ctrl'), false);
  assert.equal(isValidCombo('Ctrl+'), false);
  assert.equal(isValidCombo(''), false);
  assert.equal(isValidCombo('Ctrl+K'), true);
});

test('归一化存储写法', () => {
  assert.equal(normalizeCombo('shift+ctrl+k'), 'Ctrl+Shift+K');
  assert.equal(normalizeCombo('ctrl+escape'), 'Ctrl+Esc');
  assert.equal(normalizeCombo('Ctrl'), null);
  assert.equal(normalizeCombo(''), null);
  assert.equal(resolveBindings({ newSession: 'Ctrl+N' }).newSession, 'Ctrl+N');
});

test('逐项回落：非法或未知项不影响其它自定义', () => {
  const resolved = resolveBindings({ newSession: 'Shift+Alt+P', stopTask: 'Ctrl', unknownAction: 'Ctrl+U' });
  assert.equal(resolved.newSession, 'Shift+Alt+P', '合法自定义保留');
  assert.equal(resolved.stopTask, defaultBindings().stopTask, '非法值回落默认');
  assert.equal('unknownAction' in resolved, false, '未知动作被丢弃');
  assert.deepEqual(resolveBindings(null), defaultBindings());
  assert.deepEqual(resolveBindings('垃圾'), defaultBindings());
});

test('匹配：只命中完全相同的组合', () => {
  const bindings = defaultBindings();
  assert.equal(matchBinding(bindings, event({ key: 'k', ctrlKey: true })), 'searchSessions');
  assert.equal(matchBinding(bindings, event({ key: 'k', ctrlKey: true, shiftKey: true })), null);
  assert.equal(matchBinding(bindings, event({ key: 'Escape' })), 'stopTask');
  assert.equal(matchBinding(bindings, event({ key: 'z' })), null);
  assert.equal(matchBinding(bindings, event({ key: 'Shift' })), null, '单按修饰键不触发');
});

test('冲突检测与赋值拒绝', () => {
  const conflicts = findConflicts({ newSession: 'Ctrl+K', searchSessions: 'Ctrl+K' });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].combo, 'Ctrl+K');
  assert.deepEqual(conflicts[0].actions.sort(), ['newSession', 'searchSessions']);

  const rejected = assignBinding(defaultBindings(), 'newSession', 'Ctrl+K');
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /搜索会话/);
  assert.equal(rejected.bindings.newSession, 'Ctrl+N', '拒绝后保持原样');

  const accepted = assignBinding(defaultBindings(), 'newSession', 'ctrl+j');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.bindings.newSession, 'Ctrl+J');
  assert.equal(accepted.bindings.settings, 'Ctrl+,', '其它动作不受影响');

  const badCombo = assignBinding(defaultBindings(), 'newSession', 'Ctrl');
  assert.equal(badCombo.ok, false);
  const unknown = assignBinding(defaultBindings(), 'nope', 'Ctrl+J');
  assert.equal(unknown.ok, false);
});

test('读写与重置', () => {
  const storage = fakeStorage();
  assert.deepEqual(readBindings(storage), defaultBindings());
  writeBindings(storage, { newSession: 'Ctrl+J' });
  assert.equal(JSON.parse(storage.dump()[STORAGE_KEY]).newSession, 'Ctrl+J');
  assert.equal(readBindings(storage).newSession, 'Ctrl+J');
  storage.setItem(STORAGE_KEY, '坏数据');
  assert.deepEqual(readBindings(storage), defaultBindings());
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readBindings(throwing), defaultBindings());
  assert.equal(writeBindings(throwing, defaultBindings()), false);
  assert.deepEqual(resetBindings(storage), defaultBindings());
  assert.deepEqual(readBindings(storage), defaultBindings());
});
