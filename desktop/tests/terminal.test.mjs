import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHELLS,
  applyEvent,
  exitText,
  isBusy,
  lineCount,
  runStateLabel,
  runTone,
  selectedRun,
  tailOutput,
} from '../src/terminal.mjs';

test('shell list is an allow-list matching the Rust side', () => {
  assert.deepEqual(SHELLS.map(shell => shell.id), ['cmd', 'powershell', 'pwsh']);
  for (const shell of SHELLS) assert.ok(shell.label);
});

test('state labels and tones cover every status', () => {
  assert.equal(runStateLabel({ status: 'running' }), '运行中');
  assert.equal(runStateLabel({ status: 'completed' }), '已完成');
  assert.equal(runStateLabel({ status: 'failed' }), '失败');
  assert.equal(runStateLabel({ status: 'cancelled' }), '已取消');
  assert.equal(runStateLabel({}), '未知');
  assert.equal(runTone({ status: 'running' }), 'busy');
  assert.equal(runTone({ status: 'completed' }), 'ok');
  assert.equal(runTone({ status: 'failed' }), 'error');
  assert.equal(runTone({ status: 'cancelled' }), 'idle');
  assert.equal(isBusy({ status: 'running' }), true);
  assert.equal(isBusy({ status: 'completed' }), false);
});

test('exit text distinguishes cancel from failure', () => {
  assert.equal(exitText({ status: 'completed', exitCode: 0 }), '退出码 0');
  assert.equal(exitText({ status: 'failed', exitCode: 3 }), '退出码 3');
  assert.equal(exitText({ status: 'cancelled', exitCode: -1 }), '已取消');
  assert.equal(exitText({ status: 'running' }), '运行中');
  assert.equal(exitText({ status: 'failed', exitCode: null }), '失败');
  assert.equal(exitText(null), '');
});

test('output is tailed with a clear omission notice', () => {
  const text = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n');
  assert.equal(tailOutput('', 5), '');
  assert.equal(tailOutput('a\nb', 5), 'a\nb');
  const tailed = tailOutput(text, 3);
  assert.match(tailed, /省略前 7 行/);
  assert.ok(tailed.endsWith('line 9'));
  assert.equal(tailOutput(text, 0), '…（省略前 9 行）\nline 9', '行数下限为 1，且保留省略提示');
  assert.equal(lineCount('a\n\nb\n'), 2);
  assert.equal(lineCount(''), 0);
});

test('stream events merge into the run list', () => {
  let runs = [];
  runs = applyEvent(runs, { type: 'start', id: 1, command: 'echo hi', shell: 'cmd', cwd: '/w' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'running');
  // 重复的 start 不会插入第二条
  assert.equal(applyEvent(runs, { type: 'start', id: 1, command: 'echo hi' }).length, 1);
  runs = applyEvent(runs, { type: 'output', id: 1, stream: 'stdout', text: 'hi' });
  assert.equal(runs[0].output, 'hi\n');
  runs = applyEvent(runs, { type: 'exit', id: 1, status: 'completed', exitCode: 0 });
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].exitCode, 0);
  // 未知 id 的事件被忽略而不是造出脏记录
  assert.equal(applyEvent(runs, { type: 'output', id: 99, text: 'x' }).length, 1);
  assert.deepEqual(applyEvent(runs, null), runs);
});

test('startup errors surface as a synthetic failed run', () => {
  const runs = applyEvent([], { type: 'error', message: '已有命令在运行' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
  assert.match(runs[0].output, /已有命令在运行/);
  assert.equal(selectedRun(runs, runs[0].id), runs[0]);
  assert.equal(selectedRun(runs, 12345), null);
});
