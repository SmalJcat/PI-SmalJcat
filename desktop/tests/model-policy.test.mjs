import test from 'node:test';
import assert from 'node:assert/strict';
import desktopModelPolicy, { fastChoices, fastState, pendingEdit } from '../extensions/desktop-model-policy.mjs';

function fixture() {
  let entries = [], idle = true, queued = false;
  const handlers = {};
  const ctx = { model: { provider: 'test', id: 'model', api: 'openai-responses' },
    isIdle: () => idle, hasPendingMessages: () => queued,
    sessionManager: { getBranch: () => entries, getSessionId: () => 'session' } };
  const policy = desktopModelPolicy({ on: (name, fn) => { handlers[name] = fn; }, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) });
  return { ctx, policy, handlers, entries: value => { entries = value; }, idle: value => { idle = value; }, queued: value => { queued = value; } };
}
const edit = { type: 'custom', customType: 'desktop-message-edit', data: { entryId: 'old' } };
const user = { type: 'message', message: { role: 'user', content: 'replacement' } };

test('editing suppresses only pre-send threshold compaction, including retry/reconnect metadata', () => {
  const f = fixture(), hook = f.handlers.session_before_compact;
  f.entries([user]); assert.equal(hook({ reason: 'threshold' }, f.ctx), undefined);
  f.entries([user, edit, { type: 'model_change' }, { type: 'thinking_level_change' }, { type: 'session_info' }]);
  assert.deepEqual(hook({ reason: 'threshold' }, f.ctx), { cancel: true });
  assert.deepEqual(hook({ reason: 'threshold' }, f.ctx), { cancel: true }, 'A failed send keeps the guard for retry');
  for (const reason of ['manual', 'overflow']) assert.equal(hook({ reason }, f.ctx), undefined);
  f.entries([edit, user]); assert.equal(hook({ reason: 'threshold' }, f.ctx), undefined, 'Later tool turns and ordinary sends retain normal protection');
  f.entries([]); assert.equal(hook({ reason: 'threshold' }, f.ctx), undefined);
});

test('fast persists real priority/default payload overrides independently of reasoning', () => {
  const f = fixture(), options = { expectedSessionId: 'session', modelKey: 'test/model', enabled: true };
  const payload = { model: 'model', reasoning: { effort: 'high' }, input: [{ role: 'user', content: 'hello' }] };
  assert.equal(f.handlers.before_provider_request({ payload }, f.ctx), undefined);
  assert.equal(f.policy.set(f.ctx, options).enabled, true);
  assert.deepEqual(f.handlers.before_provider_request({ payload }, f.ctx), { ...payload, service_tier: 'priority' });
  assert.equal(Object.hasOwn(payload, 'service_tier'), false);
  f.policy.set(f.ctx, { ...options, enabled: false });
  assert.equal(f.handlers.before_provider_request({ payload: { ...payload, service_tier: 'priority' } }, f.ctx).service_tier, 'default');
  f.ctx.model = { ...f.ctx.model, id: 'other' };
  assert.equal(fastState(f.ctx).enabled, false);
  assert.equal(f.handlers.before_provider_request({ payload }, f.ctx), undefined);
});

test('fast validates stale context, running state, types and supported transports', () => {
  const f = fixture(), options = { expectedSessionId: 'session', modelKey: 'test/model', enabled: true };
  for (const patch of [{ expectedSessionId: 'stale' }, { modelKey: 'stale' }, { enabled: 'yes' }]) assert.throws(() => f.policy.set(f.ctx, { ...options, ...patch }));
  f.idle(false); assert.throws(() => f.policy.set(f.ctx, options)); f.idle(true);
  f.queued(true); assert.throws(() => f.policy.set(f.ctx, options)); f.queued(false);
  for (const api of ['anthropic-messages', 'google-generative-ai', undefined]) {
    f.ctx.model = { ...f.ctx.model, api };
    assert.equal(fastState(f.ctx).supported, false);
    assert.throws(() => f.policy.set(f.ctx, options));
    assert.equal(f.handlers.before_provider_request({ payload: {} }, f.ctx), undefined);
  }
});

test('fast settings follow the active branch and survive edit/reopen without masking the edit marker', () => {
  const f = fixture(), options = { expectedSessionId: 'session', modelKey: 'test/model', enabled: true };
  f.policy.set(f.ctx, options);
  const choices = fastChoices(f.ctx.sessionManager.getBranch());
  f.entries([{ ...edit, data: { entryId: 'old', fastModes: choices } }]);
  assert.equal(fastState(f.ctx).enabled, true);
  f.policy.set(f.ctx, { ...options, enabled: false });
  assert.equal(fastState(f.ctx).enabled, false);
  assert.ok(pendingEdit(f.ctx.sessionManager.getBranch()));
  const reopened = fixture(); reopened.entries(JSON.parse(JSON.stringify(f.ctx.sessionManager.getBranch())));
  assert.equal(reopened.policy.get(reopened.ctx).enabled, false);
  assert.ok(pendingEdit(reopened.ctx.sessionManager.getBranch()));
  f.entries([]); assert.equal(fastState(f.ctx).enabled, false, 'Abandoned branch settings are not imported');
});
