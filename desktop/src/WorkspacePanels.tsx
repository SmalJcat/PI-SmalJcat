import { useEffect, useRef, useState } from 'react';
import { Brain, Check, Copy, Layers, LoaderCircle, Play, RefreshCw, RotateCcw, Square, Users } from 'lucide-react';
import { Modal, RichText } from './components';
import type { Model, Wire } from './types';
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

export function AgentsPanel({ models, ready, cwd, onClose, onReference, onOpenParent, mainBusy }: { models: Model[]; ready: boolean; cwd: string; onClose: () => void; onReference: (text: string) => void; onOpenParent: (path: string) => void; mainBusy: boolean }) {
  const [data, setData] = useState<Wire>({ tasks: [], active: 0, concurrency: 4 }), [selected, setSelected] = useState(''), [detail, setDetail] = useState<Wire | null>(null);
  const [definition, setDefinition] = useState<Wire | null>(null), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [task, setTask] = useState(''), [batch, setBatch] = useState(false), [model, setModel] = useState(''), [thinking, setThinking] = useState('medium');
  const [filter, setFilter] = useState('all'), [onlyWorkspace, setOnlyWorkspace] = useState(false), [copied, setCopied] = useState(false);
  const createForm = useRef<HTMLFormElement>(null);
  const selectedRef = useRef(selected), mounted = useRef(true), polling = useRef(false);
  selectedRef.current = selected;
  const refresh = async () => {
    if (polling.current) return;
    polling.current = true;
    const id = selectedRef.current;
    try {
      const next = await window.pi.agentTasks({ action: 'list' });
      if (!mounted.current) return;
      setData(next);
      if (id) { const value = await window.pi.agentTasks({ action: 'detail', id }); if (mounted.current && selectedRef.current === id) setDetail(value); }
    } catch (error) { if (mounted.current) setError(errorText(error)); } finally { polling.current = false; }
  };
  useEffect(() => {
    mounted.current = true; void refresh();
    void window.pi.agentTasks({ action: 'definition' }).then(value => { if (mounted.current) { setDefinition(value); setThinking(value.thinking || 'medium'); } }).catch(error => { if (mounted.current) setError(errorText(error)); });
    const timer = setInterval(() => void refresh(), 800); return () => { mounted.current = false; clearInterval(timer); };
  }, []);
  useEffect(() => { setDetail(null); if (selected) void window.pi.agentTasks({ action: 'detail', id: selected }).then(value => { if (mounted.current && selectedRef.current === selected) setDetail(value); }).catch(error => { if (mounted.current && selectedRef.current === selected) setError(errorText(error)); }); }, [selected]);
  const operate = async (action: string, id?: string) => {
    setPending(true); setError('');
    try {
      const tasks = batch ? task.split(/\r?\n/).map(text => text.trim()).filter(Boolean) : [task.trim()];
      const result = await window.pi.agentTasks(action === 'start' ? { action, tasks, model: model === '@definition' ? '' : model, modelSource: model === '@definition' ? 'definition' : 'parent', thinking } : { action, id });
      if (action === 'start') { setTask(''); setSelected(result.tasks[0].id); }
      else if (result.id) { setSelected(result.id); setDetail(result); }
      await refresh();
    } catch (error) { setError(errorText(error)); } finally { setPending(false); }
  };
  const tasks: Wire[] = data.tasks || [];
  const visible = tasks.filter(row => (!onlyWorkspace || row.cwd.replace(/\\/g, '/').toLowerCase() === cwd.replace(/\\/g, '/').toLowerCase()) && (filter === 'all' || filter === 'active' && activeStatuses.includes(row.status) || filter === 'completed' && row.status === 'completed' || filter === 'attention' && ['failed', 'interrupted', 'cancelled'].includes(row.status)));
  const isActive = detail && activeStatuses.includes(detail.status);
  const output = [detail?.output, detail?.partial].filter(Boolean).join('\n\n');
  return <Modal title="子代理工作台" wide onClose={onClose}><div className="workspace-panel agents-panel">
    <div className="workspace-panel-heading"><div><div className="panel-eyebrow"><Users size={15} />Default 探子</div><h3>让探索并行进行</h3><p>主 Agent 与探子拥有独立上下文。任务记录会保存在本机，中断后可手动继续。</p></div><div className="agents-toolbar"><button className="secondary-button" onClick={()=>createForm.current?.scrollIntoView({block:'start'})}>新任务</button><div className="agents-capacity"><strong>{data.active || 0}</strong><span>个后台任务<br />最多 {data.concurrency} 个并行</span></div></div></div>
    {error && <div role="alert" className="notice error">{error}</div>}{data.warnings?.map((warning: string, index: number) => <div className="notice error" key={index}>{warning}</div>)}
    <div className="agents-layout"><aside className="agent-task-sidebar"><form ref={createForm} className="agent-create" onSubmit={event => { event.preventDefault(); void operate('start'); }}><h4>派发只读任务</h4><textarea aria-label="探子任务" rows={4} placeholder="写清目标、检索范围，以及需要返回的文件路径和行号" value={task} onChange={event => setTask(event.target.value)} /><label className="panel-checkbox"><input aria-label="按行拆分任务" type="checkbox" checked={batch} onChange={e => setBatch(e.target.checked)} />每行一个任务，最多 8 项</label><label className="panel-field">模型<select aria-label="探子模型" value={model} onChange={event => setModel(event.target.value)}><option value="">跟随主模型</option>{definition?.model && <option value="@definition">default 配置 · {definition.model}</option>}{models.map(model => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}</select></label><label className="panel-field">思考强度<select aria-label="探子思考强度" value={thinking} onChange={e => setThinking(e.target.value)}>{['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => <option key={level} value={level}>{level}</option>)}</select></label><button className="primary-button" disabled={pending || !ready || !task.trim()}>{pending ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}派发探子</button><p className="panel-help">权限：读取文件、搜索和列目录。代码修改与最终验证交由主 Agent。</p></form><div className="task-list-filters"><select aria-label="筛选探子状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部任务</option><option value="active">进行中</option><option value="completed">已完成</option><option value="attention">需要处理</option></select><label><input type="checkbox" checked={onlyWorkspace} onChange={e => setOnlyWorkspace(e.target.checked)} />当前工作区</label></div><nav className="agent-task-list" aria-label="探子任务列表">{visible.map(row => <button className={`agent-task-row ${selected === row.id ? 'selected' : ''}`} data-status={row.status} data-task-id={row.id} key={row.id} onClick={() => setSelected(row.id)}><span className={`task-state ${row.status}`}>{statusLabels[row.status] || row.status}</span><strong>{row.task}</strong><small>{row.model}</small></button>)}{!visible.length && <p className="panel-empty-note">这里还没有匹配的任务。</p>}</nav></aside>
      <section className="agent-task-detail">{detail ? <><div className="task-detail-heading"><div><span className={`task-state ${detail.status}`}>{statusLabels[detail.status] || detail.status}</span><h4>{detail.task}</h4><p>{detail.model} · {detail.thinking} · 第 {detail.attempts} 次运行</p></div><div className="panel-actions">{isActive ? <button className="secondary-button" disabled={pending || detail.status === 'cancelling'} onClick={() => void operate('cancel', detail.id)}><Square size={13} />取消任务</button> : <><button className="secondary-button" disabled={pending} onClick={() => void operate('retry', detail.id)}><RotateCcw size={13} />{detail.status === 'completed' ? '重新运行' : '重试任务'}</button>{detail.canResume && <button className="primary-button" disabled={pending} onClick={() => void operate('resume', detail.id)}><Play size={13} />继续会话</button>}</>}</div></div><div className="task-location"><span title={detail.cwd}>{detail.cwd}</span><button className="text-button" disabled={!detail.canOpenParent || mainBusy} onClick={() => onOpenParent(detail.parentSession)}>查看父会话</button></div><div className="task-usage"><span>输入 <b>{number(detail.usage?.tokens?.input)}</b></span><span>输出 <b>{number(detail.usage?.tokens?.output)}</b></span><span>缓存读取 <b>{number(detail.usage?.tokens?.cacheRead)}</b></span><span>费用 <b>{typeof detail.usage?.cost === 'number' ? `$${detail.usage.cost.toFixed(4)}` : '—'}</b></span></div>{detail.error && <p className="task-error">{detail.error}</p>}<div className="task-output-toolbar"><strong>{isActive ? '实时输出' : '任务结果'}</strong><div><button disabled={!output} onClick={() => void navigator.clipboard.writeText(output).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(error => setError(errorText(error)))}>{copied ? <Check size={13} /> : <Copy size={13} />}复制</button><button disabled={!output} onClick={() => onReference(`探子任务：${detail.task}\n工作区：${detail.cwd}\n\n${output.slice(0, 32000)}${output.length > 32000 ? '\n[更多结果见子代理工作台]' : ''}`)}>引用结果到消息</button></div></div><pre className="task-output" data-testid="task-output">{output || (isActive ? '等待探子输出…' : '暂无文本输出。')}</pre>{detail.truncated && <p className="panel-help">工作台展示前 128 KB 文本，完整历史保存在子会话中。</p>}{detail.tools?.length > 0 && <details className="task-tools"><summary>工具活动 · {detail.tools.length}</summary>{detail.tools.map((tool: Wire) => <div key={tool.id}><strong>{tool.name}</strong><span className={`task-state ${tool.status}`}>{statusLabels[tool.status] || tool.status}</span><code>{tool.args}</code>{tool.output && <pre>{tool.output}</pre>}</div>)}</details>}<div className="task-record-meta">创建于 {date(detail)} · 记录 {detail.id}</div></> : <div className="task-detail-empty"><Users size={32} /><h4>每个探子，独立推进</h4><p>从左侧派发任务，或让主 Agent 调用探子。<br />选择一项任务，查看实时输出和用量。</p><button className="text-button" onClick={() => void refresh()}><RefreshCw size={13} />刷新任务</button></div>}</section></div>
  </div></Modal>;
}
