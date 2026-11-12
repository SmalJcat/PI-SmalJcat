import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPromptArguments, formatPromptResult, formatResourceResult, parsePromptArguments } from '../src/mcp-content.mjs';

test('prompt arguments require a JSON object of strings and declared required keys', () => {
  const prompt = { arguments: [{ name: 'topic', required: true }, { name: 'style' }] };
  for (const value of ['[]', 'null', '{', '{"topic":42}', '{"topic":true}', '{}']) {
    assert.equal(parsePromptArguments(value, prompt).ok, false, value);
  }
  assert.deepEqual(parsePromptArguments('{"topic":"你好","style":"short"}', prompt), { ok: true, value: { topic: '你好', style: 'short' } });
  assert.equal(parsePromptArguments('{"topic":""}', prompt).ok, true, 'Required checks presence; strings may be empty');
  assert.equal(defaultPromptArguments(prompt), '{\n  "topic": ""\n}');
  assert.deepEqual(parsePromptArguments('', { arguments: [] }), { ok: true, value: {} });
});

test('prompt skeleton preserves unusual argument names as data', () => {
  const prompt = { arguments: [{ name: '__proto__', required: true }] };
  assert.equal(Object.hasOwn(JSON.parse(defaultPromptArguments(prompt)), '__proto__'), true);
  assert.equal(parsePromptArguments('{}', prompt).ok, false);
  assert.equal(parsePromptArguments('{"__proto__":"safe"}', prompt).ok, true);
});

test('resources preserve text and show binary metadata without dumping base64', () => {
  const result = formatResourceResult({ contents: [
    { uri: 'test://text', mimeType: 'text/html', text: '<script>literal</script>🙂' },
    { uri: 'test://blob', mimeType: 'application/octet-stream', blob: 'AAEC' },
  ] });
  assert.match(result, /test:\/\/text · text\/html/);
  assert.match(result, /<script>literal<\/script>🙂/);
  assert.match(result, /Base64 4 字符/);
  assert.ok(!result.includes('AAEC'));
  assert.equal(formatResourceResult({ contents: [] }), '资源内容为空。');
});

test('prompt output preserves roles, order, descriptions and embedded resources', () => {
  const output = formatPromptResult({ description: '说明', messages: [
    { role: 'user', content: { type: 'text', text: 'question' } },
    { role: 'assistant', content: { type: 'resource', resource: { uri: 'test://answer', text: 'answer' } } },
    { role: 'user', content: { type: 'image', data: 'hidden' } },
    { role: 'assistant', content: { type: 'resource_link', name: 'report', uri: 'test://report', mimeType: 'text/plain' } },
  ] });
  assert.equal(output, '说明\n\nuser\nquestion\n\nassistant\ntest://answer\nanswer\n\nuser\n[图片内容]\n\nassistant\nreport\ntest://report\ntext/plain');
  assert.equal(formatPromptResult({ messages: [] }), '提示词消息为空。');
});
