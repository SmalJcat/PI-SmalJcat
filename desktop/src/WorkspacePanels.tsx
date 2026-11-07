import { useEffect, useRef, useState } from 'react';
import { Brain, Check, Layers, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import { Modal, RichText } from './components';
import type { Wire } from './types';
import './workspace-panels.css';

const number = (value: unknown) => typeof value === 'number' ? value.toLocaleString() : '—';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const activeStatuses = ['queued', 'starting', 'running', 'cancelling'];
const statusLabels: Record<string, string> = { queued: '排队中', starting: '正在启动', running: '运行中', cancelling: '正在停止', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const reasonLabels: Record<string, string> = { manual: '手动压缩', threshold: '自动阈值压缩', overflow: '上下文溢出恢复', history: '历史压缩' };
const date = (row: Wire) => new Date(row.startedAt || row.timestamp || row.createdAt).toLocaleString();

export function ContextPanel({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<Wire | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [enabled, setEnabled] = useState(true), [reserve, setReserve] = useState(''), [keep, setKeep] = useState(''), [scope, setScope] = useState('global');
  const [instructions, setInstructions] = useState(''), [action, setAction] = useState(''), [stopping, setStopping] = useState(false);
  const loadedFor = useRef(''), polling = useRef(false), alive = useRef(true);
  const load = async (reset = false) => {
    if (polling.current) return;
    polling.current = true;
    try {
      const next = await window.pi.contextStatus();
      if (!alive.current) return;
      setData(next);
      const key = `${next.generation}:${next.modelKey}`;
      if (next.settings && (reset || loadedFor.current !== key)) {
        loadedFor.current = key; setEnabled(next.enabled ?? next.settings.enabled);
        setReserve(String(next.settings.reserveTokens)); setKeep(String(next.settings.keepRecentTokens));
        setScope(next.settings.projectTrusted ? 'project' : 'global');
      }
    } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { polling.current = false; }
  };
  useEffect(() => { alive.current = true; void load(); const timer = setInterval(() => void load(), 1000); return () => { alive.current = false; clearInterval(timer); }; }, []);
  const save = async () => {
    if (!data) return;
    setAction('save'); setError(''); setNotice('');
    try {
      await window.pi.contextConfigure({ generation: data.generation, modelKey: data.modelKey, scope, enabled, reserveTokens: Number(reserve), keepRecentTokens: Number(keep) });
      await load(true); setNotice('已保存并在当前会话生效。'); onChanged();
    } catch (error) { setError(errorText(error)); } finally { setAction(''); }
  };
  const compact = async () => {
    setAction('compact'); setError(''); setNotice('');
    try { await window.pi.command('compact', instructions.trim() ? { customInstructions: instructions.trim() } : {}); onChanged(); }
    catch (error) { setError(errorText(error)); }
    finally { setAction(''); await load(); }
  };
  const stop = async () => {
    setStopping(true); setError('');
    try { await window.pi.command('abort'); onChanged(); }
    catch (error) { setError(errorText(error)); } finally { setStopping(false); await load(); }
  };
  const windowSize = data?.model?.contextWindow || 0;
  const used = data?.usage?.tokens, trigger = data?.triggerTokens;
  const valid = reserve !== '' && keep !== '' && Number.isSafeInteger(Number(reserve)) && Number.isSafeInteger(Number(keep)) && Number(reserve) >= 0 && Number(keep) >= 0 && Number(keep) < windowSize - Number(reserve);
  return <Modal title="上下文管理" wide onClose={onClose}><div className="workspace-panel context-panel">
    <div className="workspace-panel-heading"><div><div className="panel-eyebrow"><Brain size={15} />当前会话</div><h3>{data?.model?.name || data?.modelKey || '正在读取上下文…'}</h3><p>自动压缩将较早内容整理为摘要，原始会话记录仍保留。</p></div><button className="secondary-button" onClick={() => { setError(''); void load(); }}><RefreshCw size={14} />刷新</button></div>
    {error && <div role="alert" className="notice error">{error}</div>}{notice && <div role="status" className="notice"><Check size={15} />{notice}</div>}{data?.storageError && <div className="notice error">{data.storageError}</div>}
    <div className="context-metrics"><div><small>当前用量</small><strong>{number(used)}</strong><span>{used == null ? '等待模型返回用量统计' : `${Number(data?.usage?.percent || 0).toFixed(1)}% 已使用`}</span></div><div><small>上下文窗口</small><strong>{number(windowSize || null)}</strong><span>tokens</span></div><div><small>自动压缩触发阈值</small><strong data-testid="context-trigger">{number(trigger)}</strong><span>{data?.enabled ? '自动压缩已开启' : '自动压缩已关闭'}</span></div></div>
    <div className="context-meter"><progress aria-label="上下文使用量" value={used || 0} max={windowSize || 1} />{typeof trigger === 'number' && windowSize > 0 && <span style={{ left: `${Math.max(0, Math.min(100, trigger / windowSize * 100))}%` }} title="压缩触发阈值" />}</div>
    <div className="context-columns"><section className="workspace-card"><h4>自动压缩设置</h4><label className="panel-checkbox"><input type="checkbox" aria-label="启用自动压缩" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={!data?.settings || !!action || data?.busy} />启用自动压缩</label><div className="context-fields"><label>预留 tokens<input aria-label="预留 tokens" type="number" min="0" step="1000" value={reserve} onChange={e => setReserve(e.target.value)} disabled={!data?.settings || !!action || data?.busy} /></label><label>保留近期 tokens<input aria-label="保留近期 tokens" type="number" min="0" step="1000" value={keep} onChange={e => setKeep(e.target.value)} disabled={!data?.settings || !!action || data?.busy} /></label></div><label className="panel-field">保存范围<select aria-label="压缩设置保存范围" value={scope} onChange={e => setScope(e.target.value)} disabled={!!action || data?.busy}><option value="global" disabled={data?.settings?.projectOverride}>所有项目</option>{data?.settings?.projectTrusted && <option value="project">当前项目</option>}</select></label><p className="panel-help">Token 设置仅作用于当前模型；自动开关作用于所选范围。{data?.settings?.projectTrusted === false && '当前项目尚未受信任，使用所有项目的设置。'}</p><button className="primary-button" disabled={!valid || !data?.settings || !!action || data?.busy} onClick={() => void save()}>{action === 'save' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}保存压缩设置</button></section>
      <section className="workspace-card"><h4>压缩当前上下文</h4><p className="panel-help">可指定需要保留的重点。生成摘要会调用当前模型。</p><textarea aria-label="压缩重点" rows={3} placeholder="例如：保留目标、关键约束、已修改文件和未完成事项" value={instructions} onChange={e => setInstructions(e.target.value)} disabled={!!action || data?.busy} /><div className="panel-actions"><button className="secondary-button" disabled={!data || !!action || data?.busy} onClick={() => void compact()}>{action === 'compact' ? <LoaderCircle size={14} className="spin" /> : <Layers size={14} />}{data?.history?.[0]?.status === 'failed' ? '重试压缩' : '立即压缩'}</button>{data?.isCompacting && <button className="secondary-button" disabled={stopping} onClick={() => void stop()}><Square size={13} />停止当前操作</button>}</div>{data?.isCompacting && <p className="panel-help"><LoaderCircle size={12} className="spin" />正在生成摘要…</p>}</section></div>
    <section className="context-history"><h4>压缩历史 <span>{data?.history?.length || 0}</span></h4>{data?.history?.map((row: Wire) => <article className="compaction-row" data-status={row.status} key={row.id}><div className="compaction-heading"><strong>{reasonLabels[row.reason] || '上下文压缩'}</strong><span className={`task-state ${row.status}`}>{statusLabels[row.status] || row.status}</span><time>{date(row)}</time></div><div className="compaction-numbers"><span>压缩前 {number(row.tokensBefore)}</span><span>压缩后估计 {number(row.estimatedTokensAfter)}</span>{row.durationMs != null && <span>{(row.durationMs / 1000).toFixed(1)} 秒</span>}{row.usage?.cost?.total != null && <span>${Number(row.usage.cost.total).toFixed(4)}</span>}</div>{row.error && <p className="task-error">{row.error}</p>}{row.summary && <details><summary>查看压缩摘要</summary><RichText text={row.summary} /></details>}</article>)}{data && !data.history?.length && <p className="panel-empty-note">当前会话还没有压缩记录。</p>}</section>
  </div></Modal>;
}

export { AgentsPanel } from './AgentsPanel';
