import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callTone,
  defaultArgumentsFor,
  filterTools,
  formatCallResult,
  parseArguments,
  schemaFields,
  serverStateLabel,
  serverTone,
  serverWarnings,
  transportLabel,
} from '../src/mcp.mjs';

const schema = JSON.stringify({ type: 'object', required: ['text'], properties: { text: { type: 'string' }, count: { type: 'integer' } } });

test('server state labels distinguish invalid, disabled, connected and idle', () => {
  assert.equal(serverStateLabel({ transport: 'stdio', connected: true }), '已连接');
  assert.equal(serverStateLabel({ transport: 'stdio', connected: false }), '未连接');
  assert.equal(serverStateLabel({ transport: 'stdio', enabled: false }), '已禁用');
  assert.equal(serverStateLabel({ transport: 'invalid' }), '定义无效');
  assert.equal(serverStateLabel(null), '未知');
  assert.equal(serverTone({ transport: 'stdio', connected: true }), 'ok');
  assert.equal(serverTone({ transport: 'stdio', connected: false }), 'warn');
  assert.equal(serverTone({ transport: 'invalid' }), 'error');
  assert.equal(serverTone({ transport: 'stdio', enabled: false }), 'idle');
  assert.equal(transportLabel({ transport: 'http' }), 'HTTP');
  assert.equal(transportLabel({}), '未知传输');
});

test('warnings are attributed to the server they mention', () => {
  const listing = { warnings: ['rea：缺少环境变量 TOKEN', 'other：缺少环境变量 X', '全局提示'] };
  assert.deepEqual(serverWarnings({ name: 'rea' }, listing), ['rea：缺少环境变量 TOKEN']);
  assert.deepEqual(serverWarnings({ name: 'missing' }, listing), []);
  assert.deepEqual(serverWarnings({}, listing), []);
});

test('tool filtering matches name and description case insensitively', () => {
  const tools = [{ name: 'echo', description: '回显文本' }, { name: 'search', description: 'Search the web' }];
  assert.equal(filterTools(tools, '').length, 2);
  assert.equal(filterTools(tools, 'ECHO').length, 1);
  assert.equal(filterTools(tools, 'web').length, 1);
  assert.equal(filterTools(tools, 'nothing').length, 0);
  assert.deepEqual(filterTools(null, 'x'), []);
});

test('schema fields tolerate strings, objects and broken JSON', () => {
  assert.deepEqual(schemaFields(schema), [
    { name: 'text', type: 'string', required: true },
    { name: 'count', type: 'integer', required: false },
  ]);
  assert.deepEqual(schemaFields(JSON.parse(schema)), [
    { name: 'text', type: 'string', required: true },
    { name: 'count', type: 'integer', required: false },
  ]);
  assert.deepEqual(schemaFields('{ broken'), []);
  assert.deepEqual(schemaFields(undefined), []);
  assert.deepEqual(schemaFields('{"type":"object"}'), []);
  assert.deepEqual(schemaFields('{"properties":{"tags":{"type":["string","null"]}}}'), [
    { name: 'tags', type: 'string|null', required: false },
  ]);
});

test('argument parsing accepts objects only', () => {
  assert.deepEqual(parseArguments(''), { ok: true, value: {} });
  assert.deepEqual(parseArguments('   '), { ok: true, value: {} });
  assert.deepEqual(parseArguments('{"text":"hi"}'), { ok: true, value: { text: 'hi' } });
  assert.equal(parseArguments('{"a":}').ok, false);
  assert.match(parseArguments('[1,2]').error, /JSON 对象/);
  assert.match(parseArguments('"text"').error, /JSON 对象/);
  assert.match(parseArguments('null').error, /JSON 对象/);
});

test('default arguments cover required fields with type-aware placeholders', () => {
  assert.deepEqual(JSON.parse(defaultArgumentsFor({ inputSchema: schema })), { text: '' });
  assert.deepEqual(JSON.parse(defaultArgumentsFor({ inputSchema: '{"type":"object","required":["n","b","l"],"properties":{"n":{"type":"integer"},"b":{"type":"boolean"},"l":{"type":"array"}}}' })), { n: 0, b: false, l: [] });
  assert.equal(defaultArgumentsFor({}), '{}');
});

test('call results render text, placeholders and truncation', () => {
  assert.deepEqual(formatCallResult({ content: [{ type: 'text', text: 'hello' }] }), { isError: false, text: 'hello' });
  assert.deepEqual(formatCallResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }] }), { isError: false, text: 'a\n[图片内容]' });
  assert.deepEqual(formatCallResult({ content: [{ type: 'weird' }] }), { isError: false, text: '[不支持的块：weird]' });
  assert.equal(formatCallResult({ content: [{ type: 'text', text: 'boom' }], isError: true }).isError, true);
  assert.match(formatCallResult({ content: [], structuredContent: { a: 1 } }).text, /"a": 1/);
  assert.match(formatCallResult({ content: [{ type: 'text', text: 'x' }], truncated: true }).text, /已截断/);
  assert.equal(callTone({ isError: true }), 'error');
  assert.equal(callTone({}), 'ok');
});
