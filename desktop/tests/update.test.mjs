import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availableNotice,
  canCheck,
  canDownload,
  canInstall,
  formatBytes,
  isBusy,
  phaseLabel,
  phaseTone,
  pollDelayMs,
  progressPercent,
  progressText,
  stagedPathLabel,
  statusLine,
} from '../src/update.mjs';

const state = patch => ({ phase: 'idle', currentVersion: '0.4.1', ...patch });

test('labels and tones cover every phase the backend can report', () => {
  for (const phase of ['idle', 'checking', 'available', 'downloading', 'verifying', 'ready', 'up_to_date', 'failed']) {
    assert.ok(phaseLabel(state({ phase })), `missing label for ${phase}`);
    assert.ok(['busy', 'ok', 'error', 'idle'].includes(phaseTone(state({ phase }))), `missing tone for ${phase}`);
  }
  assert.equal(phaseLabel(state({ phase: 'unknown-phase' })), '未知状态');
  assert.equal(phaseTone(state({ phase: 'failed' })), 'error');
  assert.equal(phaseTone(state({ phase: 'downloading' })), 'busy');
  assert.equal(phaseTone(state({ phase: 'ready' })), 'ok');
});

test('busy phases block a new check and drive fast polling', () => {
  for (const phase of ['checking', 'downloading', 'verifying']) {
    assert.equal(isBusy(state({ phase })), true);
    assert.equal(canCheck(state({ phase })), false);
    assert.equal(pollDelayMs(state({ phase })), 800);
  }
  assert.equal(canCheck(state({ phase: 'idle' })), true);
  assert.equal(pollDelayMs(state({ phase: 'ready' })), 0);
  // 后端显式给出的 canCheck 优先，避免前后端判断不一致时按钮乱跳。
  assert.equal(canCheck(state({ phase: 'idle', canCheck: false })), false);
});

test('action gating follows the phase machine', () => {
  assert.equal(canDownload(state({ phase: 'available' })), true);
  assert.equal(canDownload(state({ phase: 'idle' })), false);
  assert.equal(canInstall(state({ phase: 'ready' })), true);
  assert.equal(canInstall(state({ phase: 'available' })), false);
});

test('progress is clamped and ready reports complete', () => {
  assert.equal(progressPercent(state({ phase: 'downloading', progressPercent: 42.4 })), 42);
  assert.equal(progressPercent(state({ phase: 'downloading', progressPercent: 250 })), 100);
  assert.equal(progressPercent(state({ phase: 'downloading', progressPercent: -5 })), 0);
  assert.equal(progressPercent(state({ phase: 'downloading', progressPercent: 'abc' })), 0);
  assert.equal(progressPercent(state({ phase: 'ready' })), 100);
});

test('byte formatting stays readable across magnitudes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(undefined), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(12592128), '12 MB');
});

test('status line prefers the backend reason and appends the error', () => {
  assert.equal(statusLine(state({ phase: 'available', reason: '发现新版本 0.4.2（当前 0.4.1）' })), '发现新版本 0.4.2（当前 0.4.1）');
  assert.equal(statusLine(state({ phase: 'failed', reason: '校验失败，已丢弃下载内容', error: '期望 a，实际 b' })), '校验失败，已丢弃下载内容：期望 a，实际 b');
  assert.equal(statusLine(state({ phase: 'failed' })), '更新失败');
  assert.equal(statusLine(null), '尚未检查更新');
});

test('progress text and notices read naturally', () => {
  assert.equal(progressText(state({ phase: 'checking' })), '正在获取更新清单');
  assert.equal(progressText(state({ phase: 'verifying' })), '正在校验下载内容');
  assert.equal(progressText(state({ phase: 'downloading', progressPercent: 50, downloadedBytes: 6 * 1024 * 1024, totalBytes: 12 * 1024 * 1024 })), '正在下载 50%（6 MB / 12 MB）');
  assert.equal(progressText(state({ phase: 'ready' })), '');
  assert.equal(availableNotice(state({ phase: 'available', availableVersion: '0.4.2' })), '可更新：0.4.1 → 0.4.2');
  assert.equal(availableNotice(state({ phase: 'idle' })), '');
  assert.equal(stagedPathLabel(state({ stagedPath: 'C:\\Users\\x\\AppData\\updates\\0.4.2\\Pi Desktop.exe' })), '0.4.2/Pi Desktop.exe');
  assert.equal(stagedPathLabel(state({})), '');
});
