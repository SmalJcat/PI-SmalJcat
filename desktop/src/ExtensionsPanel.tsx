import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderOpen, RefreshCw, ShieldAlert, ShieldCheck } from './icons';
import type { Wire } from './types';
import { highestRisk, matchesQuery, permissionInfo, signatureLabel, sortExtensions, sortPermissions, summaryOf, verdictInfo } from './extensions.mjs';

// 「扩展与签名」卡片（P1.1）：只做只读核查——不加载扩展，也不替 Pi 决定是否运行。
export function ExtensionsPanel({ onError }: { onError: (error: unknown) => void }) {
  const [data, setData] = useState<Wire>({ extensions: [], trustedKeys: [], root: '' });
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setData(await window.pi.extensionsList());
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }, [onError]);

  useEffect(() => { void refresh(); }, [refresh]);

  const extensions: Wire[] = useMemo(() => sortExtensions(data.extensions || []), [data]);
  const visible = extensions.filter(item => matchesQuery(item, query));
  const summary = summaryOf(extensions);

  return (
    <section className="update-card extensions-card">
      <div className="update-head">
        <strong>扩展与签名</strong>
        <span className={`update-chip ${summary.needsAttention > 0 ? 'error' : 'ok'}`}>
          {summary.verified}/{summary.total} 已受信任
        </span>
      </div>
      <p className="setting-help">
        {summary.total === 0
          ? `这个目录里还没有扩展。`
          : `共 ${summary.total} 个扩展，${summary.needsAttention} 个需要确认${summary.highRisk > 0 ? `，其中 ${summary.highRisk} 个声明了高风险权限` : ''}。`}
      </p>
      {summary.needsAttention > 0 && (
        <p className="setting-help update-hint"><ShieldAlert size={13} /> 未签名或签名不受信任的扩展不会被标记为可信；启用前请先核对来源与权限。</p>
      )}
      {data.root && <p className="setting-help">目录：<code>{data.root}</code>{data.trustedKeys?.length ? `（信任 ${data.trustedKeys.length} 个密钥：${data.trustedKeys.join('、')}）` : '（尚未配置信任密钥）'}</p>}
      <div className="settings-actions update-actions">
        <button className="secondary-button" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw size={14} /> 重新扫描
        </button>
        <input
          className="extensions-filter"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="按 id / 名称 / 状态筛选"
          aria-label="筛选扩展"
        />
      </div>
      <ul className="extensions-list">
        {visible.map(item => {
          const verdict = verdictInfo(item.verdict);
          const permissions = sortPermissions(item.permissions || []);
          return (
            <li key={item.path || item.id} className={`extension-row risk-${highestRisk(item.permissions || [])}`}>
              <div className="extension-head">
                <span className={`update-chip ${verdict.tone}`}>{verdict.label}</span>
                <strong>{item.name || item.id}</strong>
                <span className="extension-version">{item.version || '—'}</span>
                {item.verdict === 'verified' ? <ShieldCheck size={14} /> : <FolderOpen size={14} />}
              </div>
              <div className="extension-meta">
                <code>{item.id}</code>
                {item.signature && <span>签名：{signatureLabel(item.signature)}</span>}
              </div>
              {permissions.length > 0 && (
                <div className="extension-permissions">
                  {permissions.map(permission => (
                    <span key={permission} className={`permission-chip risk-${permissionInfo(permission).risk}`} title={permissionInfo(permission).risk}>
                      {permissionInfo(permission).label}
                    </span>
                  ))}
                </div>
              )}
              {item.error && <p className="setting-help extension-error">{item.error}</p>}
            </li>
          );
        })}
        {visible.length === 0 && extensions.length > 0 && <li className="setting-help">没有匹配的扩展。</li>}
      </ul>
    </section>
  );
}
