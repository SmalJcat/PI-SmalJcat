// 更新面板的纯展示逻辑：不依赖 DOM，便于在 Node 中直接测试。
export const PHASE_LABELS = {
  idle: '未检查',
  checking: '正在检查',
  available: '有新版本',
  downloading: '正在下载',
  verifying: '正在校验',
  ready: '等待重启',
  up_to_date: '已是最新',
  failed: '失败',
};

export const BUSY_PHASES = ['checking', 'downloading', 'verifying'];

export const phaseLabel = state => PHASE_LABELS[state?.phase] || '未知状态';

export const isBusy = state => BUSY_PHASES.includes(state?.phase);

export const phaseTone = state => {
  if (isBusy(state)) return 'busy';
  if (state?.phase === 'failed') return 'error';
  if (state?.phase === 'ready' || state?.phase === 'available') return 'ok';
  if (state?.phase === 'up_to_date') return 'ok';
  return 'idle';
};

// 后端已经给出 canCheck/canDownload/canInstall，前端只做兜底与即时禁用。
export const canCheck = state => (typeof state?.canCheck === 'boolean' ? state.canCheck : !isBusy(state));
export const canDownload = state => state?.phase === 'available';
export const canInstall = state => state?.phase === 'ready';

export const progressPercent = state => {
  const value = Number(state?.progressPercent);
  if (!Number.isFinite(value)) return state?.phase === 'ready' ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round(value)));
};

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  // 整数值不显示多余的小数位：6 MB 而不是 6.0 MB，1.5 KB 保持一位小数。
  const rounded = size >= 10 || index === 0 ? String(Math.round(size)) : size.toFixed(1).replace(/\.0$/, '');
  return `${rounded} ${units[index]}`;
}

// 一句话说明当前状态，优先使用后端给出的原因。
export function statusLine(state) {
  if (!state || !state.phase) return '尚未检查更新';
  const detail = String(state.reason || '').trim();
  if (state.phase === 'failed') {
    const error = String(state.error || '').trim();
    return error ? `${detail || '更新失败'}：${error}` : detail || '更新失败';
  }
  if (detail) return detail;
  if (state.phase === 'idle') return '尚未检查更新';
  return phaseLabel(state);
}

// 进度条文案：下载/校验阶段显示已下载字节与百分比。
export function progressText(state) {
  if (!isBusy(state)) return '';
  const percent = progressPercent(state);
  const total = Number(state?.totalBytes) || 0;
  if (state?.phase === 'checking') return '正在获取更新清单';
  if (state?.phase === 'verifying') return '正在校验下载内容';
  return total > 0
    ? `正在下载 ${percent}%（${formatBytes(state.downloadedBytes)} / ${formatBytes(total)}）`
    : `正在下载 ${percent}%`;
}

// 轮询节奏：忙碌时快轮询，等待重启后不再轮询。
export const pollDelayMs = state => {
  if (isBusy(state)) return 800;
  return 0;
};

export const availableNotice = state => {
  if (state?.phase !== 'available') return '';
  const current = String(state.currentVersion || '').trim();
  const next = String(state.availableVersion || '').trim();
  return current && next ? `可更新：${current} → ${next}` : '';
};

export const stagedPathLabel = state => {
  const value = String(state?.stagedPath || '').trim();
  if (!value) return '';
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
};
