// Installed Pi + loopback OpenAI protocol only. No user credentials or paid model calls.
import { PiRpc } from '../electron/rpc.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root = await mkdtemp(path.join(os.tmpdir(), 'pi-edit-fast-'));
const agent = path.join(root, 'agent'), artifacts = path.resolve('artifacts');
await mkdir(agent); await mkdir(artifacts, { recursive: true });
const requests = [], events = [], checks = [];
let overflowNext = false;
const server = http.createServer(async (req, res) => {
  let text = ''; for await (const bytes of req) text += bytes;
  const body = JSON.parse(text);
  requests.push(body);
  if (overflowNext) {
    overflowNext = false;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: "This model's maximum context length is 10000 tokens. However, your messages resulted in 11000 tokens.", type: 'invalid_request_error', code: 'context_length_exceeded' } })); return;
  }
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const common = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'metadata-only' };
    frame({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: 'LOCAL_RESPONSE' }, finish_reason: null }] });
    frame({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
    res.end('data: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: 'metadata-only', choices: [{ index: 0, message: { role: 'assistant', content: 'LOCAL_SUMMARY' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const model = { id: 'metadata-only', contextWindow: 10000, maxTokens: 512, reasoning: true };
await writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: { 'local-contract': { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-only', models: [model] } } }));
await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'local-contract', defaultModel: model.id, retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 128 }, cacheWarming: { enabled: false } }));
const source = path.join(root, 'source.jsonl');
const stamp = '2026-11-01T00:00:00.000Z';
const usage = { input: 8500, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 8510, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (id, parentId, role, content, time) => ({ type: 'message', id, parentId, timestamp: new Date(time).toISOString(), message: { role, content: [{ type: 'text', text: content }], timestamp: time, ...(role === 'assistant' ? { api: 'openai-completions', provider: 'local-contract', model: model.id, stopReason: 'stop', usage } : {}) } });
const time = Date.parse(stamp);
const records = [
  { type: 'session', version: 3, id: 'edit-contract', cwd: root, timestamp: stamp },
  { type: 'model_change', id: 'c0000001', parentId: null, provider: 'local-contract', modelId: model.id, timestamp: stamp },
  message('a0000000', 'c0000001', 'user', 'Oldest context '.repeat(1000), time + 100),
  message('b0000000', 'a0000000', 'assistant', 'Oldest answer', time + 200),
  message('a0000001', 'b0000000', 'user', 'Earlier context '.repeat(1000), time + 1000),
  message('b0000001', 'a0000001', 'assistant', 'Earlier answer', time + 2000),
  message('a0000002', 'b0000001', 'user', 'edit this message', time + 3000),
  message('b0000002', 'a0000002', 'assistant', 'old answer preserved', time + 4000),
  { type: 'compaction', id: 'c0000002', parentId: 'b0000002', timestamp: new Date(time + 5000).toISOString(), summary: 'Old branch summary', firstKeptEntryId: 'a0000002', tokensBefore: 8510 },
];
await writeFile(source, records.map(JSON.stringify).join('\n') + '\n');
const extension = path.resolve('extensions/desktop-context.mjs');
let rpc;
const start = () => {
  rpc = new PiRpc(process.env.PI_DESKTOP_EXECUTABLE || 'D:/PI/pi.exe', {
    cwd: root, args: ['--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--tools', '', '--session', source, '-e', extension],
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: path.join(root, 'sessions'), PI_DESKTOP_BRIDGE_TOKEN: '', PI_DESKTOP_PERMISSION_TOKEN: '', PI_DESKTOP_PERMISSION_FILE: '', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1' },
  });
  rpc.on('event', event => events.push(event));
};
async function command(operation, payload) {
  const nonce = randomUUID(), before = events.length;
  await rpc.request('prompt', { message: `/desktop-context ${operation} ${nonce}${payload ? ' ' + JSON.stringify(payload) : ''}` });
  const prefix = `PI_DESKTOP_CONTEXT:${nonce}:`;
  const notification = events.slice(before).find(event => event.message?.startsWith(prefix));
  assert.ok(notification, `Missing ${operation} receipt`);
  const value = JSON.parse(notification.message.slice(prefix.length));
  assert.equal(value.ok, true, JSON.stringify(value));
  return value;
}
async function prompt(text) {
  const before = events.length;
  await rpc.request('prompt', { message: text });
  const deadline = Date.now() + 15000;
  while (!events.slice(before).some(event => event.type === 'agent_settled')) {
    if (Date.now() > deadline) throw new Error('Pi did not settle');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const failures = events.slice(before).filter(event => event.type === 'message_end' && event.message?.stopReason === 'error');
  return { events: events.slice(before), failures };
}
try {
  start();
  const state = await rpc.request('get_state');
  assert.equal(state.model.api, 'openai-completions');
  const options = { expectedSessionId: state.sessionId, modelKey: 'local-contract/metadata-only', enabled: true };
  assert.equal((await command('fast', options)).fastMode.enabled, true);
  const edited = await command('edit', { sessionId: state.sessionId, entryId: 'a0000002' });
  assert.equal(edited.cancelled, false);
  assert.equal((await command('get')).fastMode.enabled, true, 'Editing retains the selected tier');
  await rpc.stop(); start();
  assert.equal((await command('get')).fastMode.enabled, true, 'Reconnect restores fast settings');
  await command('edit', { sessionId: state.sessionId, entryId: 'a0000002' });
  const count = requests.length;
  const sent = await prompt('replacement prompt');
  assert.deepEqual(sent.failures, []);
  assert.equal(requests.length - count, 1, 'Edit resend must not call a summary model before the response');
  assert.equal(requests.at(-1).service_tier, 'priority');
  assert.ok(sent.events.some(event => event.type === 'compaction_end' && event.reason === 'threshold' && event.aborted === true), 'High old usage actually attempted threshold compaction and was cancelled');
  const file = await readFile(source, 'utf8');
  assert.ok(file.includes('old answer preserved') && file.includes('Old branch summary'));
  checks.push('真实 Pi 高用量历史编辑重发只发一次请求，旧分支保留，预检阈值摘要取消');
  await command('fast', { ...options, enabled: false });
  await prompt('standard tier request');
  assert.equal(requests.at(-1).service_tier, 'default');
  await rpc.stop(); start();
  assert.equal((await command('get')).fastMode.enabled, false);
  checks.push('Fast priority/default 实际请求载荷及编辑、重连恢复');
  const beforeManual = requests.length;
  await rpc.request('compact', {}, 15000);
  assert.ok(requests.length > beforeManual, 'Manual compaction still reaches the provider');
  checks.push('手动压缩仍运行');
  overflowNext = true;
  const beforeOverflow = requests.length;
  const overflow = await prompt('overflow recovery request '.repeat(1000));
  assert.ok(overflow.events.some(event => event.type === 'compaction_end' && event.reason === 'overflow' && !event.aborted && !event.errorMessage), `Overflow still compacts successfully: ${JSON.stringify(overflow.failures)}`);
  assert.ok(requests.length - beforeOverflow >= 3, 'Overflow makes failing request, summary and retry');
  checks.push('真实溢出仍触发摘要和自动重试');
  await writeFile(path.join(artifacts, 'edit-fast-contract-result.json'), JSON.stringify({ success: true, checks, localProviderRequests: requests.length, externalModelRequests: 0 }, null, 2));
  console.log(JSON.stringify({ success: true, checks, localProviderRequests: requests.length, externalModelRequests: 0 }));
} catch (error) {
  await writeFile(path.join(artifacts, 'edit-fast-contract-result.json'), JSON.stringify({ success: false, error: String(error), checks, requestCount: requests.length, events: events.filter(event => ['compaction_start', 'compaction_end', 'transport_exit'].includes(event.type)) }, null, 2));
  throw error;
} finally {
  await rpc?.stop();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
