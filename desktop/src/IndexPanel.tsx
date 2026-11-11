import { useCallback, useEffect, useState } from 'react';
import { Database, RefreshCw, Search } from './icons';
import type { Wire } from './types';
import { formatBytes } from './format.mjs';

// 本地任务索引（P3.3）：SQLite 缓存，替代"每次读全部任务记录"的检索。
// 索引可随时重建；记录文件仍是事实来源。
// 字数展示：超过一万用"万"表示，便于扫读
const formatCount = (value: number) => (value >= 10000 ? Math.round(value / 1000) / 10 + ' 万' : String(value));

export function IndexPanel({ onError }: { onError: (error: unknown) => void }) {
  const [stats, setStats] = useState<Wire>({});
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Wire>({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  // 会话正文索引（另一套索引：FTS5 全文检索）的状态
  const [sessionStats, setSessionStats] = useState<Wire>({});
  const [sessionNote, setSessionNote] = useState('');

  const loadStats = useCallback(async () => {
    try {
      setStats(await window.pi.indexStats());
    } catch (error) {
      onError(error);
    }
  }, [onError]);

  const search = useCallback(async (target = page) => {
    setBusy('search');
    try {
      const data = await window.pi.indexSearch({ query, role, page: target, pageSize: 20 });
      setResult(data);
      setPage(target);
    } catch (error) {
      onError(error);
    } finally {
      setBusy('');
    }
  }, [onError, page, query, role]);

  const loadSessionStats = useCallback(async () => {
    try {
      const value = await window.pi.sessionIndexStats();
      setSessionStats(value.stats || {});
    } catch (error) {
      onError(error);
    }
  }, [onError]);

  useEffect(() => { void loadStats(); void loadSessionStats(); }, [loadStats, loadSessionStats]);

  const rebuild = useCallback(async () => {
    setBusy('rebuild');
    setNote('');
    try {
      const data = await window.pi.indexRebuild();
      setStats(data.stats || {});
      setNote(`已索引 ${data.summary?.indexed ?? 0} 条（跳过 ${data.summary?.skipped ?? 0} 条），耗时 ${data.summary?.elapsedMs ?? 0} ms`);
      await search(1);
    } catch (error) {
      onError(error);
    } finally {
      setBusy('');
    }
  }, [onError, search]);

  const bytes = Number(stats.bytes) || 0;
  const size = bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const rebuiltAt = Number(stats.lastRebuildAtMs) > 0 ? new Date(Number(stats.lastRebuildAtMs)).toLocaleString() : '尚未重建';

  return (
    <section className="update-card index-card">
      <div className="update-head">
        <strong>本地任务索引</strong>
        <span className="update-chip idle">{Number(stats.tasks) || 0} 条</span>
      </div>
      <p className="setting-help">{size} · 归档 {Number(stats.archived) || 0} 条</p><details className="diagnostics"><summary>索引详情</summary><p>上次重建：{rebuiltAt} · 结构版本 {String(stats.schemaVersion ?? '—')}</p></details>
      <div className="settings-actions update-actions">
        <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void rebuild()}>
          <Database size={14} /> {busy === 'rebuild' ? '正在重建…' : '重建索引'}
        </button>
        <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void loadStats()}>
          <RefreshCw size={14} /> 刷新概况
        </button>
        <input
          className="extensions-filter"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') void search(1); }}
          placeholder="按关键词检索任务（Enter）"
          aria-label="索引检索"
        />
        <select value={role} onChange={event => setRole(event.target.value)} aria-label="按角色筛选">
          <option value="">全部角色</option>
          <option value="scout">只读探子</option>
          <option value="verifier">验证者</option>
          <option value="editor">编辑者</option>
          <option value="runner">执行者</option>
        </select>
        <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void search(1)}>
          <Search size={14} /> 检索
        </button>
      </div>
      {note && <p className="setting-help update-notice">{note}</p>}
      <div className="pref-row">
        <div className="pref-meta">
          <span className="pref-label">会话正文索引</span>
          <span className="pref-hint">{Number(sessionStats.files) || 0} 个会话 · {formatCount(Number(sessionStats.chars) || 0)} 字</span>
        </div>
        <div className="shortcut-control">
          <span className="storage-size">{formatBytes(Number(sessionStats.bytes) || 0)}</span>
          <button
            className="secondary-button"
            disabled={busy === 'session'}
            onClick={() => {
              setBusy('session');
              setSessionNote('');
              void window.pi
                .sessionIndexSync()
                .then(value => {
                  const summary = value.summary || {};
                  setSessionStats(value.stats || {});
                  setSessionNote(`已同步：${summary.files ?? 0} 个会话（新索引 ${summary.indexed ?? 0}，跳过 ${summary.skipped ?? 0}，清理 ${summary.removed ?? 0}）`);
                })
                .catch(onError)
                .finally(() => setBusy(''));
            }}
          >
            {busy === 'session' ? '正在同步…' : '同步会话索引'}
          </button>
        </div>
      </div>
      {sessionNote && <p className="setting-help update-notice">{sessionNote}</p>}
      {result.items?.length > 0 && (
        <>
          <ul className="extensions-list index-results">
            {result.items.map((item: Wire) => (
              <li key={item.id} className="extension-row">
                <div className="extension-head">
                  <span className="update-chip idle">{item.status}</span>
                  <strong>{item.title || item.id}</strong>
                  <span className="extension-version">{item.role || 'scout'}</span>
                </div>
                <div className="extension-meta">
                  <code>{item.id.slice(0, 12)}</code>
                  <span>{item.cwd}</span>
                </div>
              </li>
            ))}
          </ul>
          <div className="settings-actions update-actions">
            <button className="secondary-button" disabled={page <= 1 || Boolean(busy)} onClick={() => void search(page - 1)}>上一页</button>
            <span className="setting-help">第 {result.page} / {Math.max(1, result.totalPages)} 页 · 共 {result.total} 条</span>
            <button className="secondary-button" disabled={page >= result.totalPages || Boolean(busy)} onClick={() => void search(page + 1)}>下一页</button>
          </div>
        </>
      )}
    </section>
  );
}
