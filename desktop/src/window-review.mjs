// 独立审阅窗口的纯逻辑：状态文案、初始选中、补丁统计与回引文本。
export const STATUS_LABELS = {
  M: '已修改',
  A: '新增',
  D: '已删除',
  R: '已重命名',
  C: '已复制',
  U: '未跟踪',
  '??': '未跟踪',
};

export const statusLabel = status => STATUS_LABELS[String(status || '').trim()] || String(status || '').trim() || '变更';

export const stageLabel = stage => (stage === 'staged' ? '已暂存' : '未暂存');

// 回引到主窗口输入框的文本，与主窗口既有引用格式保持一致。
export const referenceText = (path, line) => `请查看文件：${path}:${clampLine(line)}`;

export const clampLine = line => {
  const value = Number(line);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), 1_000_000);
};

// 初始选中：优先用打开窗口时指定的文件，其次是第一个改动文件。
export const pickFile = (files, preferred) => {
  const list = Array.isArray(files) ? files : [];
  if (preferred && list.some(file => file?.path === preferred)) return preferred;
  return list[0]?.path || '';
};

// 补丁统计：只数 ± 行，忽略 diff 头，便于在标题栏给出概览。
export const diffSummary = patch => {
  const text = String(patch || '');
  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('@@')) hunks += 1;
    else if (line.startsWith('+++') || line.startsWith('---')) continue;
    else if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed, hunks, text: `+${added} −${removed}` };
};

// 预览可能是补丁（diff=true）或整份文件；只有补丁才显示 +/− 统计。
export const previewTitle = (preview, file, stage) =>
  preview?.diff ? `${file}（${stageLabel(stage)}）` : `${file}（完整文件）`;

export const isPatch = preview => preview?.diff === true;
