import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonLines, PiRpc } from '../electron/rpc.mjs';
import { branchMessages, listSessions, withinWorkspace, previewFile, attachmentsFromPaths, gitChanges, gitDiff } from '../electron/workspace.mjs';
import { emptyTranscript, reduceTranscript, loadTranscript, textContent } from '../src/transcript.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

async function temporary(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-desktop-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('JSONL preserves split UTF-8, CRLF, U+2028 and U+2029', () => {
  const records = [], errors = [];
  const parser = new JsonLines(record => records.push(record), error => errors.push(error));
  const expected = [{ text: '你好🙂\u2028下一行\u2029end' }, { type: 'done' }];
  const bytes = Buffer.from(expected.map(v => JSON.stringify(v)).join('\r\n') + '\n');
  for (let i = 0; i < bytes.length; i++) parser.push(bytes.subarray(i, i + 1));
  parser.end();
  assert.deepEqual(records, expected); assert.equal(errors.length, 0);
});

test('malformed protocol records do not break the next valid record', () => {
  const records = [], errors = [];
  const parser = new JsonLines(record => records.push(record), error => errors.push(error));
  parser.push(Buffer.from('not json\n{"type":"ok"}\n')); parser.end();
  assert.equal(errors.length, 1); assert.equal(records[0].type, 'ok');
});

test('streaming reconstruction replaces partial blocks and final message without duplicates', () => {
  let state = emptyTranscript();
  const apply = event => { state = reduceTranscript(state, event); };
  apply({ type: 'agent_start' });
  apply({ type: 'message_start', message: { role: 'user', content: '你好' } });
  apply({ type: 'message_end', message: { role: 'user', content: '你好' } });
  apply({ type: 'message_start', message: { role: 'assistant', content: [] } });
  apply({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '检查' } });
  apply({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '片段' } });
  apply({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: '完整片段' } });
  assert.equal(state.messages[1].content[1].text, '完整片段');
  apply({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '最终文本' }], stopReason: 'stop' } });
  apply({ type: 'agent_end', willRetry: true });
  assert.equal(state.running, true);
  apply({ type: 'agent_settled', aborted: false });
  assert.equal(state.running, false);
  assert.equal(state.messages.length, 2);
  assert.equal(textContent(state.messages[1].content), '最终文本');
});

test('parallel tool lifecycles stay correlated and survive authoritative results', () => {
  let state = emptyTranscript();
  for (const id of ['a', 'b']) state = reduceTranscript(state, { type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path: id } });
  state = reduceTranscript(state, { type: 'tool_execution_end', toolCallId: 'b', result: { content: [{ type: 'text', text: 'B' }] }, isError: true, durationMs: 21 });
  state = reduceTranscript(state, { type: 'message_end', message: { role: 'toolResult', toolCallId: 'a', toolName: 'read', content: [{ type: 'text', text: 'A' }] } });
  assert.equal(state.tools.b.status, 'error'); assert.equal(state.tools.a.status, 'done');
  assert.equal(state.tools.a.args.path, 'a');
  const restored = loadTranscript(state.messages);
  assert.equal(restored.tools.a.result.content[0].text, 'A');
});

test('history follows the selected branch and keeps pre-compaction messages visible', () => {
  const entries = [
    { id: 'a', parentId: null, type: 'message', message: { role: 'user', content: 'root' } },
    { id: 'b', parentId: 'a', type: 'message', message: { role: 'assistant', content: 'abandoned' } },
    { id: 'c', parentId: 'a', type: 'compaction', summary: 'summary', timestamp: '2026-01-01' },
    { id: 'd', parentId: 'c', type: 'message', message: { role: 'user', content: 'selected' } },
  ];
  assert.deepEqual(branchMessages(entries, 'd').map(m => m.content || m.summary), ['root', 'summary', 'selected']);
  assert.deepEqual(branchMessages(entries, null), []);
});

test('session index reads metadata and latest title, tolerating a trailing partial record', async t => {
  const dir = await temporary(t), config = path.join(dir, 'agent'), cwd = path.join(dir, 'work');
  await mkdir(path.join(config, 'sessions', '--work--'), { recursive: true }); await mkdir(cwd);
  const file = path.join(config, 'sessions', '--work--', 'one.jsonl');
  await writeFile(file, [
    { type: 'session', id: 'one', cwd },
    { type: 'message', message: { role: 'user', content: 'initial' } },
    { type: 'session_info', name: 'old title' },
    { type: 'session_info', name: '新的名称' },
  ].map(JSON.stringify).join('\n') + '\n{"unfinished":');
  const sessions = await listSessions(cwd, config);
  assert.equal(sessions.length, 1); assert.equal(sessions[0].name, '新的名称'); assert.equal(sessions[0].cwd, cwd);
});

test('workspace reads reject traversal and junction escapes; large previews are bounded', async t => {
  const dir = await temporary(t), cwd = path.join(dir, 'work'), outside = path.join(dir, 'outside');
  await mkdir(cwd); await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await symlink(outside, path.join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(withinWorkspace(cwd, '../outside/secret.txt'), /工作区之外/);
  await assert.rejects(withinWorkspace(cwd, 'link/secret.txt'), /工作区之外/);
  await writeFile(path.join(cwd, 'large.txt'), 'a'.repeat(300000));
  const preview = await previewFile(cwd, 'large.txt');
  assert.equal(preview.truncated, true); assert.equal(preview.content.length, 256 * 1024);
});

test('attachments support text/images and reject binary and oversized text', async t => {
  const dir = await temporary(t), text = path.join(dir, '你好.txt'), binary = path.join(dir, 'data.bin');
  await writeFile(text, '文件内容'); await writeFile(binary, Buffer.from([0, 1, 2]));
  assert.equal((await attachmentsFromPaths([text]))[0].text, '文件内容');
  await assert.rejects(attachmentsFromPaths([binary]), /二进制/);
  await writeFile(text, 'x'.repeat(262145));
  await assert.rejects(attachmentsFromPaths([text]), /256 KB/);
  await assert.rejects(attachmentsFromPaths(Array(9).fill(text)), /8 个/);
});

test('Git preview includes staged and unstaged changes without executing textconv', async t => {
  const dir = await temporary(t);
  await exec('git', ['init'], { cwd: dir });
  await writeFile(path.join(dir, 'file.txt'), 'initial\n');
  await exec('git', ['add', '.'], { cwd: dir });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test'], { cwd: dir });
  await writeFile(path.join(dir, 'file.txt'), 'staged\n'); await exec('git', ['add', '.'], { cwd: dir });
  await writeFile(path.join(dir, 'file.txt'), 'unstaged\n'); await writeFile(path.join(dir, '新文件.txt'), 'untracked');
  const changes = await gitChanges(dir); assert.equal(changes.available, true); assert.equal(changes.files.length, 2);
  const diff = await gitDiff(dir, 'file.txt'); assert.match(diff.content, /已暂存/); assert.match(diff.content, /未暂存/);
  assert.equal((await gitDiff(dir, '新文件.txt')).content, 'untracked');
  await mkdir(path.join(dir, 'sub'));
  await writeFile(path.join(dir, 'sub', 'child.txt'), 'child');
  const nested = await gitChanges(path.join(dir, 'sub'));
  assert.deepEqual(nested.files.map(file => file.path), ['child.txt']);
  assert.equal((await gitDiff(path.join(dir, 'sub'), 'child.txt')).content, 'child');
});

test('RPC correlates out-of-order responses, rejects failures, times out and shuts down its child', async t => {
  const dir = await temporary(t);
  const rpc = new PiRpc(process.execPath, { cwd: dir, prefixArgs: [path.join(root, 'tests/fixture-pi.mjs')], args: ['--no-session'], env: { ...process.env, PI_CODING_AGENT_DIR: dir } });
  t.after(() => rpc.stop());
  const [a, b] = await Promise.all([rpc.request('echo', { value: 'slow', delay: 40 }), rpc.request('echo', { value: 'fast', delay: 1 })]);
  assert.equal(a.value, 'slow'); assert.equal(b.value, 'fast');
  await assert.rejects(rpc.request('invalid'), /Unknown/);
  await assert.rejects(rpc.request('hang', {}, 30), /超时/);
  await rpc.stop(); assert.equal(rpc.closed, true);
});
