import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampLine,
  diffSummary,
  isPatch,
  pickFile,
  previewTitle,
  referenceText,
  stageLabel,
  statusLabel,
} from '../src/window-review.mjs';

test('status labels cover the codes Git actually emits', () => {
  assert.equal(statusLabel('M'), '已修改');
  assert.equal(statusLabel('A'), '新增');
  assert.equal(statusLabel('D'), '已删除');
  assert.equal(statusLabel('R'), '已重命名');
  assert.equal(statusLabel('??'), '未跟踪');
  assert.equal(statusLabel(' XY '), 'XY');
  assert.equal(statusLabel(''), '变更');
  assert.equal(statusLabel(undefined), '变更');
  assert.equal(stageLabel('staged'), '已暂存');
  assert.equal(stageLabel('working'), '未暂存');
  assert.equal(stageLabel(undefined), '未暂存');
});

test('reference text matches the main window format and clamps the line', () => {
  assert.equal(referenceText('src/App.tsx', 42), '请查看文件：src/App.tsx:42');
  assert.equal(referenceText('src/App.tsx'), '请查看文件：src/App.tsx:1');
  assert.equal(referenceText('a b/c.md', 0), '请查看文件：a b/c.md:1');
  assert.equal(clampLine(-5), 1);
  assert.equal(clampLine('12.9'), 12);
  assert.equal(clampLine(2_000_000), 1_000_000);
  assert.equal(clampLine('abc'), 1);
});

test('initial selection prefers the requested file and falls back to the first', () => {
  const files = [{ path: 'a.ts' }, { path: 'b.ts' }];
  assert.equal(pickFile(files, 'b.ts'), 'b.ts');
  assert.equal(pickFile(files, 'missing.ts'), 'a.ts');
  assert.equal(pickFile([], 'a.ts'), '');
  assert.equal(pickFile(null, 'a.ts'), '');
  assert.equal(pickFile(files, ''), 'a.ts');
});

test('diff summary counts added and removed lines but ignores headers', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,2 +1,3 @@',
    ' keep',
    '-old line',
    '+new line',
    '+another',
    '@@ -10 +11 @@',
    '-x',
    '+y',
  ].join('\n');
  const summary = diffSummary(patch);
  assert.equal(summary.added, 3);
  assert.equal(summary.removed, 2);
  assert.equal(summary.hunks, 2);
  assert.equal(summary.text, '+3 −2');
  assert.deepEqual(diffSummary(''), { added: 0, removed: 0, hunks: 0, text: '+0 −0' });
});

test('titles distinguish patches from whole files', () => {
  assert.equal(previewTitle({ diff: true }, 'a.ts', 'staged'), 'a.ts（已暂存）');
  assert.equal(previewTitle({ diff: false }, 'a.ts', 'working'), 'a.ts（完整文件）');
  assert.equal(isPatch({ diff: true }), true);
  assert.equal(isPatch({}), false);
});
