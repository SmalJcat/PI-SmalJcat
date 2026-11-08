// 独立审阅窗口：只读工作区变更与补丁，并把文件引用发回主窗口。
// 它没有会话、工具或进程能力：命令侧按窗口标签再次校验。
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { changeGroups } from '../workflows.mjs';
import { diffSummary, isPatch, pickFile, previewTitle, stageLabel, statusLabel } from '../window-review.mjs';

type Wire = Record<string, any>;

const root = document.getElementById('root')!;
root.innerHTML = `
  <style>
    :root { color-scheme: dark; font-family: 'Segoe UI Variable', 'Microsoft YaHei UI', sans-serif; font-size: 13px; }
    body { margin: 0; background: #10161d; color: #dbe6ef; }
    header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #22303b; }
    header strong { font-size: 12px; }
    header .path { font-size: 10px; color: #8ea3b5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    header .spacer { margin-left: auto; display: flex; gap: 8px; }
    button { font: inherit; padding: 5px 10px; border-radius: 6px; border: 1px solid #2f4150; background: #17212b; color: inherit; cursor: pointer; }
    button:hover:not(:disabled) { background: #1d2a36; }
    button:disabled { opacity: .45; cursor: default; }
    main { display: grid; grid-template-columns: 280px 1fr; height: calc(100vh - 45px); }
    .list { border-right: 1px solid #22303b; overflow: auto; padding: 8px; }
    .group-title { font-size: 10px; color: #8ea3b5; margin: 10px 4px 6px; }
    .file { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 7px 8px; border-radius: 6px; border: 1px solid transparent; background: none; }
    .file:hover { background: #17212b; }
    .file.selected { border-color: #2f4150; background: #17212b; }
    .file .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
    .file .status { font-size: 10px; color: #8ea3b5; }
    .viewer { display: flex; flex-direction: column; overflow: hidden; }
    .viewer-head { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid #22303b; font-size: 11px; }
    .viewer-head .stat { color: #9fd8b4; }
    .viewer-body { flex: 1; overflow: auto; padding: 10px 0; }
    pre { margin: 0; font-family: ui-monospace, Consolas, monospace; font-size: 11px; line-height: 1.7; white-space: pre; }
    .line { display: flex; }
    .line > span:first-child { width: 52px; text-align: right; padding-right: 14px; color: #6f8496; user-select: none; }
    .line.added { background: rgba(90, 200, 140, .12); color: #c9f5d9; }
    .line.removed { background: rgba(255, 140, 140, .12); color: #ffd7d4; }
    .line.hunk { color: #8ea3b5; background: rgba(255, 255, 255, .03); }
    .empty { padding: 30px; text-align: center; color: #8ea3b5; font-size: 12px; }
    .badge { font-size: 10px; border: 1px solid #2f4150; border-radius: 999px; padding: 1px 7px; color: #8ea3b5; }
  </style>
  <header>
    <strong>改动审阅</strong>
    <span class="badge" id="stage">未暂存</span>
    <span class="path" id="cwd"></span>
    <div class="spacer">
      <button id="refresh">刷新</button>
      <button id="reference" disabled>引用到主窗口</button>
    </div>
  </header>
  <main>
    <aside class="list" id="list"></aside>
    <section class="viewer">
      <div class="viewer-head"><span id="title">未选择文件</span><span class="stat" id="stat"></span></div>
      <div class="viewer-body" id="body"><div class="empty">从左边选择一个文件查看差异。</div></div>
    </section>
  </main>
`;

const list = document.getElementById('list')!;
const body = document.getElementById('body')!;
const title = document.getElementById('title')!;
const stat = document.getElementById('stat')!;
const cwd = document.getElementById('cwd')!;
const stageBadge = document.getElementById('stage')!;
const reference = document.getElementById('reference') as HTMLButtonElement;

let current: { path: string; stage: string; line: number } | null = null;
let preferred = '';

const esc = (value: string) => value.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] as string);

function renderPatch(patch: string) {
  return String(patch || '')
    .split(/\r?\n/)
    .map(line => {
      const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : '';
      return `<div class="line ${cls}"><span></span><span>${esc(line) || '&nbsp;'}</span></div>`;
    })
    .join('');
}

function renderFull(content: string) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line, index) => `<div class="line"><span>${index + 1}</span><span>${esc(line) || '&nbsp;'}</span></div>`)
    .join('');
}

async function openFile(path: string, stage: string, line = 1) {
  current = { path, stage, line };
  reference.disabled = false;
  stageBadge.textContent = stageLabel(stage);
  title.textContent = path;
  try {
    const preview: Wire = await invoke('review-diff', { relative: path, stage });
    title.textContent = previewTitle(preview, path, stage);
    stat.textContent = isPatch(preview) ? diffSummary(preview.content).text : '';
    body.innerHTML = isPatch(preview)
      ? renderPatch(preview.content || '')
      : renderFull(preview.content || '（空文件）');
  } catch (error) {
    stat.textContent = '';
    body.innerHTML = `<div class="empty">读取失败：${esc(String(error))}</div>`;
  }
}

async function refresh() {
  try {
    const context: Wire = await invoke('review-context');
    cwd.textContent = context.cwd || '';
    if (context.file) preferred = context.file;
    const changes: Wire = await invoke('review-changes');
    const groups = changeGroups(changes.files || []);
    const files = (changes.files || []).map((file: Wire) => ({ path: file.path }));
    list.innerHTML = groups
      .filter(group => group.files.length > 0)
      .map(group => `<div class="group-title">${group.title} · ${group.files.length}</div>` +
        group.files.map((file: Wire) => `<button class="file" data-path="${esc(file.path)}" data-stage="${group.id}">
            <span class="name">${esc(file.path)}</span><span class="status">${statusLabel(file.status)}</span>
          </button>`).join(''))
      .join('') || '<div class="empty">当前没有未提交的改动。</div>';
    for (const button of Array.from(list.querySelectorAll('.file'))) {
      button.addEventListener('click', () => {
        void openFile(button.getAttribute('data-path') || '', button.getAttribute('data-stage') || 'working');
      });
    }
    const target = pickFile(files, preferred);
    if (target) {
      const group = groups.find(entry => entry.files.some((file: Wire) => file.path === target));
      await openFile(target, group?.id || 'working');
      preferred = '';
    } else {
      current = null;
      reference.disabled = true;
      body.innerHTML = '<div class="empty">从左边选择一个文件查看差异。</div>';
    }
  } catch (error) {
    list.innerHTML = `<div class="empty">读取失败：${esc(String(error))}</div>`;
  }
}

document.getElementById('refresh')!.addEventListener('click', () => void refresh());
reference.addEventListener('click', () => {
  if (!current) return;
  void invoke('review-reference', { relative: current.path, line: current.line })
    .then(() => {
      reference.textContent = '已引用';
      setTimeout(() => (reference.textContent = '引用到主窗口'), 1200);
    })
    .catch(error => (stat.textContent = String(error)));
});

void listen('review://refresh', () => void refresh());
void refresh();
