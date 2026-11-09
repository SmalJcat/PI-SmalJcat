import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseViewports, parseThemes, matchesOnly, freshness, mergeFindings, renderReport, auditPage } from './ui-capture-lib.mjs';

test('arguments select scenarios, viewports, themes and build policy', () => {
  const options = parseArgs(['--only', 'settings,agents-detail', '--widths', '1280x800,1024', '--themes', 'all', '--no-build', '--no-audit']);
  assert.deepEqual(options.only, ['settings', 'agents-detail']);
  assert.deepEqual(options.viewports, [{ width: 1280, height: 800 }, { width: 1024, height: 640 }]);
  assert.deepEqual(options.themes, ['chatgpt', 'cyberpunk', 'classic']);
  assert.equal(options.build, 'never');
  assert.equal(options.audit, false);
  assert.equal(parseArgs(['--build']).build, 'always');
  assert.equal(parseArgs([]).build, 'auto');
  assert.throws(() => parseArgs(['--only']), /需要参数/);
  assert.throws(() => parseArgs(['--bogus']), /未知参数/);
  assert.throws(() => parseViewports('wide'), /无效视口/);
  assert.throws(() => parseViewports('320x200'), /超出范围/);
  assert.throws(() => parseThemes('light'), /未知主题/);
});

test('only filter matches a scenario and its named captures', () => {
  assert.equal(matchesOnly([], 'anything'), true);
  assert.equal(matchesOnly(['settings'], 'settings-03'), true);
  assert.equal(matchesOnly(['settings'], 'settingsx'), false);
  assert.equal(matchesOnly(['agents-detail'], 'agents-empty'), false);
});

test('freshness trusts a matching stamp, otherwise falls back to modification times', () => {
  const stamp = { source: 'src-a', exe: 'exe-a' };
  assert.equal(freshness({ stamp, sourceSha: 'src-a', exeSha: 'exe-a' }).fresh, true);
  assert.match(freshness({ stamp, sourceSha: 'src-b', exeSha: 'exe-a' }).reason, /源码/);
  assert.match(freshness({ stamp, sourceSha: 'src-a', exeSha: 'exe-b' }).reason, /替换/);
  assert.equal(freshness({ stamp: null, sourceSha: 's', exeSha: 'e', exeMtimeMs: 20, newestSourceMtimeMs: 10 }).fresh, true);
  assert.equal(freshness({ stamp: null, sourceSha: 's', exeSha: 'e', exeMtimeMs: 5, newestSourceMtimeMs: 10 }).fresh, false);
  assert.match(freshness({ stamp: null, sourceSha: 's', exeSha: '' }).reason, /尚未构建/);
});

test('findings merge across variants and sort by severity', () => {
  const merged = mergeFindings([
    { variant: '1440x900', findings: [{ type: 'small-text', selector: 'span', detail: '10px' }, { type: 'text-overlap', selector: 'div.a', detail: 'x' }] },
    { variant: '1024x768', findings: [{ type: 'text-overlap', selector: 'div.a', detail: 'x', count: 2 }] },
  ]);
  assert.equal(merged[0].type, 'text-overlap');
  assert.deepEqual(merged[0].where, ['1440x900', '1024x768']);
  assert.equal(merged[0].count, 3);
});

test('report states build freshness, failures and per-interface findings', () => {
  const report = renderReport({
    capturedAt: '2026-11-09T00:00:00Z', version: '0.7.0', executable: 'pi-desktop.exe',
    source: { commit: '0123456789abcdef', dirty: true, sha256: 'abc' },
    build: { fresh: false, reason: '源码在上次构建之后有改动', exeSha: 'def' },
    viewports: [{ width: 1440, height: 900 }], themes: ['chatgpt'],
    failures: [{ id: 'mcp', error: 'timeout | x', screenshot: 'FAILED-mcp.png' }],
    captures: [{ id: 'home', title: '首页', shots: [{ variant: '1440x900', file: 'home@1440x900.png', findings: [{ type: 'offscreen', selector: 'button.x', detail: '超出' }] }] }],
  });
  assert.match(report, /可能过期/);
  assert.match(report, /含未提交改动/);
  assert.match(report, /timeout \\\| x/);
  assert.match(report, /\[1440x900\]\(home@1440x900\.png\)/);
  assert.match(report, /元素超出窗口边界/);
});

test('browser audit stays self-contained for page.evaluate', () => {
  // Serialised functions lose module scope; referencing helpers outside would fail in the WebView.
  const source = auditPage.toString();
  for (const name of ['FINDING_TYPES', 'SEVERITY', 'mergeFindings', 'parseArgs']) assert.equal(source.includes(name), false, name);
});
