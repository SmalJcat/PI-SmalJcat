import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Eraser, Play, RefreshCw } from './icons';
import { Modal } from './components';
import type { Wire } from './types';
import { SHELLS, applyEvent, exitText, isBusy, runStateLabel, runTone, selectedRun, tailOutput } from './terminal.mjs';

// 工作区命令面板（P3）：在当前工作区跑命令，流式看输出，可取消、可回看历史。
export function TerminalPanel({ cwd, onClose, onError }: { cwd: string; onClose: () => void; onError: (error: unknown) => void }) {
  const [shell, setShell] = useState('cmd');
  const [command, setCommand] = useState('');
  const [runs, setRuns] = useState<Wire[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await window.pi.terminalHistory(20);
      setRuns(data.runs || []);
      setActiveId(current => current ?? data.runs?.[0]?.id ?? null);
    } catch (error) {
      onError(error);
    }
  }, [onError]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 输出事件由 Rust 侧推送，这里只做归并，不轮询。
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<Wire>('terminal://event', event => {
        const payload = event.payload || {};
        setRuns(current => applyEvent(current, payload));
        if (payload.type === 'start') setActiveId(payload.id);
        if (payload.type === 'error') setActiveId(0);
      }))
      .then(unlisten => { dispose = unlisten; })
      .catch(() => {});
    return () => { if (dispose) dispose(); };
  }, []);

  const active = useMemo(() => selectedRun(runs, activeId) || runs[0] || null, [activeId, runs]);
  const running = runs.some(run => isBusy(run));
  const output = useMemo(() => tailOutput(active?.output, 400), [active?.output]);

  useEffect(() => {
    if (follow && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [output, follow]);

  const run = useCallback(async () => {
    if (!command.trim()) return;
    try {
      await window.pi.terminalRun({ command, shell });
      setCommand('');
    } catch (error) {
      onError(error);
    }
  }, [command, onError, shell]);

  const cancel = useCallback(async () => {
    try {
      await window.pi.terminalCancel();
    } catch (error) {
      onError(error);
    }
  }, [onError]);

  return (
    <Modal title="工作区命令" wide className="terminal-modal" onClose={onClose}>
        <div className="terminal-subhead">
          <div className="terminal-head">
            <span className="setting-help">{cwd || '未选择工作区'}</span>
          </div>
          <div className="header-actions">
            <button className="secondary-button" onClick={() => void refresh()}>
              <RefreshCw size={14} /> 历史
            </button>
            <button className="secondary-button" onClick={() => void window.pi.terminalClear().then(() => setRuns([])).catch(onError)}>
              <Eraser size={14} /> 清空
            </button>
          </div>
        </div>
        <div className="terminal-body">
          <aside className="terminal-history">
            {runs.map(item => (
              <button
                key={item.id}
                className={`terminal-run ${item.id === active?.id ? 'selected' : ''}`}
                onClick={() => setActiveId(item.id)}
              >
                <span className={`update-chip ${runTone(item)}`}>{runStateLabel(item)}</span>
                <code>{item.command}</code>
                <small>{exitText(item)}</small>
              </button>
            ))}
            {runs.length === 0 && <p className="setting-help">还没有运行过命令。</p>}
          </aside>
          <section className="terminal-main">
            <div className="terminal-toolbar">
              <select value={shell} onChange={event => setShell(event.target.value)} disabled={running} aria-label="Shell">
                {SHELLS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <input
                value={command}
                onChange={event => setCommand(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter' && !running) void run(); }}
                placeholder="输入命令，Enter 运行"
                aria-label="命令"
                disabled={running}
              />
              <button className="primary-button" disabled={running || !command.trim()} onClick={() => void run()}>
                <Play size={14} /> 运行
              </button>
              <button className="secondary-button" disabled={!running} onClick={() => void cancel()}>
                <Ban size={14} /> 取消
              </button>
              <label className="terminal-follow">
                <input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> 跟随输出
              </label>
            </div>
            <div className="terminal-mode">非交互命令</div>{active && <code className="terminal-current">{active.command}</code>}
            <div className="terminal-output" ref={body}>
              <pre>{output || '（还没有输出）'}</pre>
            </div>
            {active && (
              <div className="terminal-status">
                <span className={`update-chip ${runTone(active)}`}>{runStateLabel(active)}</span>
                <span>{exitText(active)}</span>
                {active.truncated && <span>输出已截断（上限 512 KB）</span>}
                {active.cwd && <span className="muted">{active.cwd}</span>}
              </div>
            )}
          </section>
        </div>
    </Modal>
  );
}
