import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, Download, RefreshCw, RotateCw } from './icons';
import type { Wire } from './types';
import { availableNotice, canCheck, canDownload, canInstall, isBusy, phaseLabel, phaseTone, pollDelayMs, progressPercent, progressText, stagedPathLabel, statusLine } from './update.mjs';

// 「更新」卡片：检查 → 下载 → 校验 → 等待重启。状态全部来自 Rust 侧，前端只做展示与门禁。
export function UpdatePanel({ onError }: { onError: (error: unknown) => void }) {
  const [status, setStatus] = useState<Wire>({ phase: 'idle' });
  const [working, setWorking] = useState(false);
  const [draft, setDraft] = useState('');
  const [localOpen, setLocalOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await window.pi.updateStatus();
      setStatus(next);
    } catch (error) {
      onError(error);
    }
  }, [onError]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 忙碌阶段短轮询，让下载进度动起来；空闲后自动停止。
  useEffect(() => {
    const delay = pollDelayMs(status);
    if (!delay) return;
    const timer = window.setTimeout(() => { void refresh(); }, delay);
    return () => window.clearTimeout(timer);
  }, [status, refresh]);

  const run = useCallback(async (action: () => Promise<Wire>) => {
    setWorking(true);
    try {
      setStatus(await action());
    } catch (error) {
      onError(error);
      await refresh();
    } finally {
      setWorking(false);
    }
  }, [onError, refresh]);

  const tone = phaseTone(status);
  const percent = progressPercent(status);
  const notice = availableNotice(status);
  const staged = stagedPathLabel(status);
  const disabled = working || isBusy(status);

  return (
    <section className="update-card" data-tone={tone}>
      <div className="update-head">
        <strong>应用更新</strong>
        <span className={`update-chip ${tone}`}>{phaseLabel(status)}</span>
      </div>
      <p className="setting-help">{statusLine(status)}</p>
      {isBusy(status) && (
        <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={progressText(status)}>
          <div className="update-bar"><span style={{ width: `${percent}%` }} /></div>
          <small>{progressText(status)}</small>
        </div>
      )}
      {notice && <p className="setting-help update-notice">{notice}</p>}
      {staged && <p className="setting-help">已暂存：<code>{staged}</code></p>}
      {!status.sourceConfigured && status.phase === 'idle' && (
        <p className="setting-help update-hint"><CircleAlert size={13} /> 未配置更新源</p>
      )}
      <div className="settings-actions update-actions">
        <button className="secondary-button" disabled={disabled || !canCheck(status)} onClick={() => void run(() => window.pi.updateCheck())}>
          <RefreshCw size={14} /> 检查更新
        </button>
        <button className="primary-button" disabled={disabled || !canDownload(status)} onClick={() => void run(() => window.pi.updateDownload())}>
          <Download size={14} /> 下载并校验
        </button>
        <button className="secondary-button" disabled={disabled || !canInstall(status)} onClick={() => void run(() => window.pi.updateInstall())}>
          <RotateCw size={14} /> 下次启动更新
        </button>
      </div>
      <details className="diagnostics update-manifest" open={localOpen} onToggle={event => setLocalOpen((event.target as HTMLDetailsElement).open)}>
        <summary>本地清单与更新源</summary><p className="setting-help">在线更新可设置 <code>PI_DESKTOP_UPDATE_URL</code> 后重启。</p>
        <textarea
          value={draft}
          onChange={event => setDraft(event.target.value)}
          spellCheck={false}
          rows={5}
          placeholder={'粘贴 release.json 内容（version / executable / bytes / sha256 / url）'}
        />
        <div className="settings-actions">
          <button
            className="secondary-button"
            disabled={working || !draft.trim()}
            onClick={() => void run(() => window.pi.updateCheck({ manifest: draft }))}
          >
            用这份清单检查
          </button>
          <button className="secondary-button" disabled={working} onClick={() => setDraft('')}>清空</button>
        </div>
      </details>
    </section>
  );
}
