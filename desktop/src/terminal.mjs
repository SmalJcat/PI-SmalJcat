// 命令面板的纯逻辑：状态文案、输出尾部、事件归并。
export const SHELLS = [
  { id: 'cmd', label: 'cmd' },
  { id: 'powershell', label: 'Windows PowerShell' },
  { id: 'pwsh', label: 'PowerShell 7' },
];

export const RUN_STATES = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const runStateLabel = run => RUN_STATES[run?.status] || '未知';

export const runTone = run => {
  if (!run || run.status === 'running') return 'busy';
  if (run.status === 'completed') return 'ok';
  if (run.status === 'cancelled') return 'idle';
  return 'error';
};

export const isBusy = run => run?.status === 'running';

// 退出码文案：取消不是失败，单独说明。
export const exitText = run => {
  if (!run) return '';
  if (run.status === 'running') return '运行中';
  if (run.status === 'cancelled') return '已取消';
  const raw = run.exitCode;
  // 结束但没有退出码（例如进程被外部结束）时不要谎报"退出码 0"。
  if (raw === null || raw === undefined || raw === '') return runStateLabel(run);
  const code = Number(raw);
  if (!Number.isFinite(code)) return runStateLabel(run);
  return code === 0 ? '退出码 0' : `退出码 ${code}`;
};

// 只保留尾部若干行，避免把 512 KB 输出一次性塞进 DOM。
export const tailOutput = (text, lines = 400) => {
  const value = String(text || '');
  if (!value) return '';
  const parts = value.split(/\r?\n/);
  const parsed = Number(lines);
  // 非数字（含缺省）用 400 行；其余夹到 [1, 1000000]，避免 0 或负数把输出清空。
  const keep = Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 1), 1_000_000) : 400;
  const slice = parts.slice(-keep);
  const prefix = parts.length > keep ? `…（省略前 ${parts.length - keep} 行）\n` : '';
  return prefix + slice.join('\n');
};

export const lineCount = text => {
  const value = String(text || '');
  if (!value) return 0;
  return value.split(/\r?\n/).filter(line => line.length > 0).length;
};

// 把一条流事件并进运行列表：输出追加、退出更新状态。
export function applyEvent(runs, event) {
  const list = Array.isArray(runs) ? runs : [];
  if (!event || typeof event !== 'object') return list;
  if (event.type === 'error') {
    return [{ id: 0, command: '（未启动）', status: 'failed', output: String(event.message || '命令启动失败'), exitCode: null, shell: '', cwd: '' }, ...list];
  }
  if (event.type === 'start') {
    if (list.some(run => run.id === event.id)) return list;
    return [
      {
        id: event.id,
        command: String(event.command || ''),
        shell: String(event.shell || ''),
        cwd: String(event.cwd || ''),
        status: 'running',
        output: '',
        exitCode: null,
        startedAtMs: Date.now(),
      },
      ...list,
    ];
  }
  const index = list.findIndex(run => run.id === event.id);
  if (index < 0) return list;
  const next = [...list];
  const run = { ...next[index] };
  if (event.type === 'output') {
    run.output = run.output + String(event.text ?? '') + '\n';
  } else if (event.type === 'exit') {
    run.status = String(event.status || 'completed');
    run.exitCode = event.exitCode === undefined || event.exitCode === null ? null : Number(event.exitCode);
  }
  next[index] = run;
  return next;
}

export const selectedRun = (runs, id) => (runs || []).find(run => run.id === id) || null;
