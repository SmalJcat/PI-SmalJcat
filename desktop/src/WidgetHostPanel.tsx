import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw, ShieldCheck, ShieldAlert, X } from './icons';
import type { Wire } from './types';
import { auditTone, formatTime, riskLabel, splitAuditApi } from './widgets.mjs';

// MCP Apps 沙箱宿主（P1.2b）：宿主只暴露固定白名单，widget 在独立 WebView 里运行。
// 本面板负责选 widget、逐项授权、开窗与查看审计；判定一律由 Rust 侧完成。
export function WidgetHostPanel({ onError }: { onError: (error: unknown) => void }) {
  const [catalog, setCatalog] = useState<Wire>({ apis: [], widgets: [] });
  const [selected, setSelected] = useState<Wire | null>(null);
  const [grants, setGrants] = useState<string[]>([]);
  const [opened, setOpened] = useState<Wire | null>(null);
  const [audit, setAudit] = useState<Wire[]>([]);
  const [busy, setBusy] = useState(false);

  const loadAudit = useCallback(async () => {
    try {
      const data = await window.pi.widgetAudit(60);
      setAudit(data.entries || []);
    } catch (error) {
      onError(error);
    }
  }, [onError]);

  useEffect(() => {
    void (async () => {
      try {
        setCatalog(await window.pi.widgetCatalog());
      } catch (error) {
        onError(error);
      }
      await loadAudit();
    })();
  }, [loadAudit, onError]);

  const apis: Wire[] = catalog.apis || [];
  const widgets: Wire[] = catalog.widgets || [];
  const baseApis = useMemo(() => apis.filter(api => !api.extended && selected?.requested?.includes(api.name)), [apis, selected]);
  const extendedApis = useMemo(() => apis.filter(api => api.extended && selected?.requested?.includes(api.name)), [apis, selected]);

  const pick = (widget: Wire) => {
    setSelected(widget);
    // 默认全部拒绝：只勾选使用者明确同意的基础能力。
    setGrants([]);
    setOpened(null);
  };

  const toggle = (name: string) => {
    setGrants(current => (current.includes(name) ? current.filter(value => value !== name) : [...current, name]));
  };

  const open = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await window.pi.widgetOpen({
        widget: selected.id,
        requested: selected.requested || [],
        granted: grants,
      });
      setOpened(result);
      await loadAudit();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }, [grants, loadAudit, onError, selected]);

  const close = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await window.pi.widgetClose(selected.id);
      setOpened(null);
      await loadAudit();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }, [loadAudit, onError, selected]);

  const session = opened?.session;

  return (
    <section className="update-card widget-card">
      <div className="update-head">
        <strong>MCP Apps 演示</strong>
        <span className={`update-chip ${opened ? 'ok' : 'idle'}`}>{opened ? '窗口已打开' : '未打开'}</span>
      </div>
      <p className="setting-help">内置演示 · 模拟能力</p>
      <div className="settings-actions update-actions">
        <button className="secondary-button" disabled={busy} onClick={() => void loadAudit()}>
          <RefreshCw size={14} /> 刷新审计
        </button>
        {opened && (
          <button className="secondary-button" disabled={busy} onClick={() => void close()}>
            <X size={14} /> 关闭沙箱窗口
          </button>
        )}
      </div>
      <ul className="extensions-list widget-list">
        {widgets.map(widget => (
          <li key={widget.id} className={`extension-row ${selected?.id === widget.id ? 'selected' : ''}`}>
            <div className="extension-head">
              <button type="button" className="text-button" onClick={() => pick(widget)}>
                <ExternalLink size={14} /> <strong>{widget.title || widget.id}</strong>
              </button>
              <span className="extension-version">{widget.source}</span>
            </div>
            <div className="extension-meta">
              <code>{widget.id}</code>
              <span>申请 {Number((widget.requested || []).length)} 项能力</span>
            </div>
          </li>
        ))}
        {widgets.length === 0 && <li className="setting-help">还没有可用的 widget 目录。</li>}
      </ul>
      {selected && (
        <div className="widget-grants">
          <div className="mcp-call-head">
            <ShieldCheck size={14} />
            <strong>{selected.id}</strong>
            <span className="setting-help">已选 {grants.length} / {(selected.requested || []).length} 项</span>
          </div>

          <fieldset className="widget-grant-group">
            <legend>基础能力</legend>
            {baseApis.map(api => (
              <label key={api.name} className={`widget-grant risk-${api.risk}`}>
                <input
                  type="checkbox"
                  checked={grants.includes(api.name)}
                  onChange={() => toggle(api.name)}
                />
                <span>
                  <code>{api.name}</code>
                  <small title={api.note}>{riskLabel(api.risk)}风险</small>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="widget-grant-group">
            <legend>高风险能力</legend>
            {extendedApis.map(api => (
              <label key={api.name} className="widget-grant risk-high">
                <input
                  type="checkbox"
                  checked={grants.includes(api.name)}
                  onChange={() => toggle(api.name)}
                />
                <span>
                  <code>{api.name}</code>
                  <small>{api.note} · 风险 {riskLabel(api.risk)}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {extendedApis.some(api => grants.includes(api.name)) && (
            <p className="setting-help update-hint">
              <ShieldAlert size={13} /> 已选择高风险能力（演示）
            </p>
          )}
          <div className="settings-actions update-actions">
            <button className="primary-button" disabled={busy} onClick={() => void open()}>
              打开沙箱窗口
            </button>
            <button className="secondary-button" disabled={busy} onClick={() => setGrants([])}>
              全部拒绝
            </button>
          </div>
          {session && (
            <p className="setting-help">
              已授权 {session.allowed?.length || 0} 项
              {session.denied?.length ? `，未授权 ${session.denied.length} 项` : ''}
              {session.unknown?.length ? `，未知能力 ${session.unknown.length} 项（已拒绝）` : ''}
              {opened?.reused ? '（复用已有窗口）' : ''}
            </p>
          )}
        </div>
      )}
      <div className="widget-audit">
        <strong>审计（最近 {audit.length} 条）</strong>
        <ul>
          {audit.map((entry: Wire, index) => {
            const parts = splitAuditApi(entry.api);
            return (
              <li key={`${entry.atMs}-${index}`} className={`audit-row ${auditTone(entry)}`}>
                <span className="audit-time">{formatTime(entry.atMs)}</span>
                <span className="audit-api">{parts.api}</span>
                <span className="audit-detail">{entry.detail}</span>
              </li>
            );
          })}
          {audit.length === 0 && <li className="setting-help">还没有调用记录。</li>}
        </ul>
      </div>
    </section>
  );
}
