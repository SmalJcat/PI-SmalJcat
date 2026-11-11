import test from 'node:test';
import assert from 'node:assert/strict';
import { displayCost, emptyResponseSpeed, responseSpeed } from '../src/composer-metrics.mjs';
const start = { type: 'message_start', message: { role: 'assistant' } };
const end = (output = 40, stopReason = 'stop') => ({ type: 'message_end', message: { role: 'assistant', usage: { output }, stopReason } });
test('response speed uses output tokens over a fully observed response and excludes tool waits', () => {
  let value = responseSpeed(emptyResponseSpeed(), start, 100);
  value = responseSpeed(value, end(), 2100);
  assert.equal(value.tokensPerSecond, 20);
  value = responseSpeed(value, { type: 'tool_execution_start' }, 2200);
  value = responseSpeed(value, start, 12100);
  assert.equal(value.tokensPerSecond, null);
  value = responseSpeed(value, end(100), 13100);
  assert.equal(value.tokensPerSecond, 100);
  assert.equal(responseSpeed(value, { type: 'agent_settled' }, 14000).tokensPerSecond, 100);
  assert.deepEqual(responseSpeed(value, { type: 'agent_start' }, 15000), emptyResponseSpeed());
  assert.deepEqual(responseSpeed(value, { type: 'transport_exit' }, 15000), emptyResponseSpeed());
});
test('speed stays unknown for replay, missing usage, invalid counts, aborted replies or tiny intervals', () => {
  assert.equal(responseSpeed(emptyResponseSpeed(), end(), 1000).tokensPerSecond, null);
  for (const output of [0, -1, NaN, Infinity, '40', null]) {
    assert.equal(responseSpeed(responseSpeed(emptyResponseSpeed(), start, 0), end(output), 1000).tokensPerSecond, null);
  }
  for (const reason of ['error', 'aborted']) assert.equal(responseSpeed(responseSpeed(emptyResponseSpeed(), start, 0), end(40, reason), 1000).tokensPerSecond, null);
  assert.equal(responseSpeed(responseSpeed(emptyResponseSpeed(), start, 1000), end(), 1001).tokensPerSecond, null);
  assert.equal(responseSpeed(responseSpeed(emptyResponseSpeed(), start, 1000), end(), 900).tokensPerSecond, null);
});
test('cost distinguishes missing, zero, small values and reported currencies', () => {
  for (const cost of [undefined, {}, { amount: null, currency: 'USD' }, { amount: -1, currency: 'USD' }, { amount: Infinity, currency: 'USD' }, { amount: 1, currency: '' }]) assert.equal(displayCost(cost), '—');
  assert.equal(displayCost({ amount: 0, currency: 'USD' }), '$0.0000');
  assert.equal(displayCost({ amount: .0123, currency: 'USD' }), '$0.0123');
  assert.equal(displayCost({ amount: .00001, currency: 'USD' }), '$<0.0001');
  assert.equal(displayCost({ amount: 1.25, currency: 'EUR' }), 'EUR 1.2500');
});
