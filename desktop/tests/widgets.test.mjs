import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_CHANNEL,
  SANDBOX_ATTRIBUTES,
  auditTone,
  buildRenderMessage,
  formatTime,
  grantSummary,
  initialGrants,
  parseWidgetEvent,
  preflight,
  riskLabel,
  splitAuditApi,
  widgetFrameUrl,
} from '../src/widgets.mjs';

test('sandbox attributes never grant same-origin access', () => {
  assert.equal(SANDBOX_ATTRIBUTES, 'allow-scripts');
  assert.ok(!SANDBOX_ATTRIBUTES.includes('allow-same-origin'), '不能给同一源权限');
  assert.ok(!SANDBOX_ATTRIBUTES.includes('allow-top-navigation'));
  assert.ok(!SANDBOX_ATTRIBUTES.includes('allow-popups'));
});

test('grants start empty and summarise honestly', () => {
  assert.deepEqual(initialGrants(), []);
  assert.deepEqual(grantSummary([], [], []), { allowed: 0, denied: 0, unknown: 0, text: '已授权 0 项' });
  assert.equal(grantSummary(['a'], ['b'], []).text, '已授权 1 项，未授权 1 项');
  assert.equal(grantSummary(['a'], [], ['x']).text, '已授权 1 项，未知能力 1 项');
  assert.equal(riskLabel('high'), '高');
  assert.equal(riskLabel('nope'), '未知');
});

test('frame url encodes the widget id', () => {
  assert.equal(widgetFrameUrl('fixture.weather'), './widget-sandbox.html?widget=fixture.weather');
  assert.equal(widgetFrameUrl('a b/c'), './widget-sandbox.html?widget=a%20b%2Fc');
});

test('render message uses the host channel and opaque-origin target', () => {
  const message = buildRenderMessage('fixture.weather', { city: '香港' });
  assert.equal(message.targetOrigin, '*');
  assert.equal(message.payload[HOST_CHANNEL], 1);
  assert.equal(message.payload.widget, 'fixture.weather');
  assert.equal(message.payload.data.city, '香港');
});

test('widget events are checked for source and shape', () => {
  const frame = {};
  const good = { source: frame, data: { pi: 1, id: 'c1', api: 'setTheme', payload: {} } };
  const parsed = parseWidgetEvent(good, frame);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.message.api, 'setTheme');

  assert.equal(parseWidgetEvent({ source: {}, data: good.data }, frame).ok, false);
  assert.match(parseWidgetEvent({ source: {}, data: good.data }, frame).reason, /来源/);
  assert.equal(parseWidgetEvent({ source: frame, data: null }, frame).ok, false);
  assert.equal(parseWidgetEvent({ source: frame, data: [1] }, frame).ok, false);
  assert.equal(parseWidgetEvent({ source: frame, data: { pi: 2 } }, frame).ok, false);
  assert.equal(parseWidgetEvent({ source: frame, data: { pi: 1, id: '', api: 'x' } }, frame).ok, false);
  assert.equal(parseWidgetEvent({ source: frame, data: { pi: 1, id: 'c', api: '' } }, frame).ok, false);
  assert.equal(parseWidgetEvent(good, null).ok, false);
});

test('preflight blocks ungranted calls and huge messages', () => {
  assert.deepEqual(preflight({ pi: 1, id: 'c', api: 'setTheme' }, ['setTheme']).ok, true);
  assert.match(preflight({ api: 'runUserCode' }, ['setTheme']).reason, /未授权/);
  assert.equal(preflight(null, []).ok, false);
  const huge = { api: 'setTheme', blob: 'x'.repeat(70 * 1024) };
  assert.match(preflight(huge, ['setTheme']).reason, /过大/);
});

test('audit formatting splits widget and api and marks failures', () => {
  assert.deepEqual(splitAuditApi('fixture.weather::setTheme'), { widget: 'fixture.weather', api: 'setTheme' });
  assert.deepEqual(splitAuditApi('setTheme'), { widget: '', api: 'setTheme' });
  assert.equal(auditTone({ ok: true }), 'ok');
  assert.equal(auditTone({ ok: false }), 'error');
  assert.equal(formatTime(0), '—');
  assert.match(formatTime(Date.UTC(2026, 0, 1, 3, 4, 5)), /^\d\d:\d\d:\d\d$/);
});
