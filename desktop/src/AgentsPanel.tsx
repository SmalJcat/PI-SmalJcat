import { useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, Play, RefreshCw, RotateCcw, Square, Users } from './icons';
import { Modal } from './components';
import type { Model, Wire } from './types';
import './workspace-panels.css';
const number = (value: unknown) => typeof value === 'number' ? value.toLocaleString() : '—';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const activeStatuses = ['queued', 'starting', 'running', 'cancelling'];
const statusLabels: Record<string, string> = { queued: '排队中', starting: '正在启动', running: '运行中', cancelling: '正在停止', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const date = (row: Wire) => new Date(row.createdAt).toLocaleString();
export function AgentsPanel({ models, ready, cwd, onClose, onReference, onOpenParent, mainBusy }: { models: Model[]; ready: boolean; cwd: string; onClose: () => void; onReference: (text: string) => void; onOpenParent: (path: string) => void; mainBusy: boolean }) {
  const [data, setData] = useState<Wire>({ tasks: [], active: 0, concurrency: 4 });
  const [selected, setSelected] = useState(''), [detail, setDetail] = useState<Wire | null>(null);
  const [definition, setDefinition] = useState<Wire | null>(null), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [task, setTask] = useState(''), [batch, setBatch] = useState(false), [model, setModel] = useState(''), [role, setRole] = useState('scout'), [roles, setRoles] = useState<Wire[]>([]), [worktrees, setWorktrees] = useState<Wire>({ worktrees: [], repo: '' }), [thinking, setThinking] = useState('medium');
  const [options, setOptions] = useState({ query: '', status: 'all', onlyWorkspace: false, archive: 'current', page: 1, pageSize: 20 });
  const [copied, setCopied] = useState(false), [full, setFull] = useState<Wire | null>(null), [outputLoading, setOutputLoading] = useState(false);
  const removeWorktree = async (path: string) => {
    try {
      await window.pi.worktreeRemove(path);
      await refresh();
      setWorktrees(await window.pi.worktreeList());
      if (selected) await loadDetail(selected);
    } catch (error) { setError(errorText(error)); }
  };
  const [offsets, setOffsets] = useState([0]), [outputIndex, setOutputIndex] = useState(0);
  const createForm = useRef<HTMLFormElement>(null), selectedRef = useRef(selected), mounted = useRef(true), polling = useRef(false);
  const outputRequest = useRef(0), detailRequest = useRef(0), fullRef = useRef<Wire | null>(null);
  const requestKey = JSON.stringify({ action: 'list', query: options.query, status: options.status, archive: options.archive, page: options.page, pageSize: options.pageSize, ...(options.onlyWorkspace ? { cwd } : {}) });
  const requestRef = useRef(requestKey);
  selectedRef.current = selected; requestRef.current = requestKey; fullRef.current = full;
  const clearOutput = () => { outputRequest.current++; setFull(null); fullRef.current = null; setOffsets([0]); setOutputIndex(0); setOutputLoading(false); setCopied(false); };
  const loadDetail = async (id: string) => {
    const sequence = ++detailRequest.current;
    const value = await window.pi.agentTasks({ action: 'detail', id });
    if (!mounted.current || selectedRef.current !== id || sequence !== detailRequest.current) return;
    setDetail(value);
    if (activeStatuses.includes(value.status) || fullRef.current && fullRef.current.attempts !== value.attempts) clearOutput();
  };
  const refresh = async () => {
    if (polling.current) return;
    polling.current = true;
    const key = requestRef.current;
    try {
      const next = await window.pi.agentTasks(JSON.parse(key));
      if (!mounted.current) return;
      if (requestRef.current === key) {
        setData({ ...next, requestKey: key });
        if (next.page !== JSON.parse(key).page) setOptions(previous => ({ ...previous, page: next.page }));
      }
      const id = selectedRef.current;
      if (id) await loadDetail(id);
    } catch (error) { if (mounted.current && requestRef.current === key) setError(errorText(error)); }
    finally { polling.current = false; }
  };
  useEffect(() => {
    mounted.current = true; void refresh();
    void window.pi.agentTasks({ action: 'definition' }).then(value => { if (mounted.current) { setDefinition(value); setThinking(value.thinking || 'medium'); } }).catch(error => { if (mounted.current) setError(errorText(error)); });
    void window.pi.agentRoles().then(value => { if (mounted.current) setRoles(value.roles || []); }).catch(error => { if (mounted.current) setError(errorText(error)); });
    void window.pi.worktreeList().then(value => { if (mounted.current) setWorktrees(value); }).catch(() => {});
    const timer = setInterval(() => void refresh(), 800);
    return () => { mounted.current = false; outputRequest.current++; detailRequest.current++; clearInterval(timer); };
  }, []);
  useEffect(() => { void refresh(); }, [requestKey]);
  useEffect(() => {
    setDetail(null); clearOutput(); setError('');
    if (selected) void loadDetail(selected).catch(error => { if (mounted.current && selectedRef.current === selected) setError(errorText(error)); });
  }, [selected]);
  const loadOutput = async (offset = 0, index = 0, reset = false) => {
    const id = selectedRef.current, sequence = ++outputRequest.current;
    setOutputLoading(true); setError(''); setCopied(false);
    try {
      const value = await window.pi.agentTasks({ action: 'output', id, offset, ...(!reset && fullRef.current ? { version: fullRef.current.version } : {}) });
      if (!mounted.current || selectedRef.current !== id || sequence !== outputRequest.current) return;
      setFull({ ...value, attempts: detail?.attempts });
      setOffsets(previous => [...previous.slice(0, index), offset]); setOutputIndex(index);
    } catch (error) { if (mounted.current && sequence === outputRequest.current && selectedRef.current === id) setError(errorText(error)); }
    finally { if (mounted.current && sequence === outputRequest.current) setOutputLoading(false); }
  };
  const operate = async (action: string, id?: string) => {
    setPending(true); setError('');
    if (['start', 'retry', 'resume'].includes(action)) clearOutput();
    try {
      const tasks = batch ? task.split(/\r?\n/).map(text => text.trim()).filter(Boolean) : [task.trim()];
      const result = await window.pi.agentTasks(action === 'start' ? { action, tasks, role, model: model === '@definition' ? '' : model, modelSource: model === '@definition' ? 'definition' : 'parent', thinking } : { action, id });
      if (!mounted.current) return;
      if (action === 'start') { setTask(''); setSelected(result.tasks[0].id); }
      else if (result.id && (!id || selectedRef.current === id)) { setSelected(result.id); setDetail(result); }
      await refresh();
    } catch (error) { if (mounted.current) setError(errorText(error)); }
    finally { if (mounted.current) setPending(false); }
  };
  const changeFilter = (values: Partial<typeof options>) => setOptions(previous => ({ ...previous, ...values, page: 1 }));
  const listReady = data.requestKey === requestKey;
  const visible: Wire[] = listReady ? data.tasks || [] : [];
  const isActive = detail && activeStatuses.includes(detail.status);
  const output = full ? full.text : [detail?.output, detail?.partial].filter(Boolean).join('\n\n');
  return <Modal title="子代理工作台" wide onClose={onClose}><div className="workspace-panel agents-panel">
    <div className="workspace-panel-heading"><div><div className="panel-eyebrow"><Users size={15} />Default 探子</div><h3>让探索并行进行</h3><p>主 Agent 与探子拥有独立上下文。任务记录会保存在本机，中断后可手动继续。</p></div><div className="agents-toolbar"><button className="secondary-button" onClick={()=>createForm.current?.scrollIntoView({block:'start'})}>新任务</button><div className="agents-capacity"><strong>{data.active || 0}</strong><span>个后台任务<br />最多 {data.concurrency} 个并行</span></div></div></div>
    {error && <div role="alert" className="notice error">{error}</div>}{data.warnings?.map((warning: string, index: number) => <div className="notice error" key={index}>{warning}</div>)}
    <div className="agents-layout"><aside className="agent-task-sidebar"><form ref={createForm} className="agent-create" onSubmit={event => { event.preventDefault(); void operate('start'); }}><h4>派发子代理任务</h4><textarea aria-label="探子任务" rows={4} placeholder="写清目标、检索范围，以及需要返回的文件路径和行号" value={task} onChange={event => setTask(event.target.value)} /><label className="panel-checkbox"><input aria-label="按行拆分任务" type="checkbox" checked={batch} onChange={e => setBatch(e.target.checked)} />每行一个任务，最多 8 项</label><label className="panel-field">角色<select aria-label="子代理角色" value={role} onChange={event => setRole(event.target.value)}>{roles.map(entry => <option key={entry.id} value={entry.id}>{entry.label}{entry.writable ? '（可写 · 独立 worktree）' : ''}</option>)}</select></label><label className="panel-field">模型<select aria-label="探子模型" value={model} onChange={event => setModel(event.target.value)}><option value="">跟随主模型</option>{definition?.model && <option value="@definition">default 配置 · {definition.model}</option>}{models.map(model => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}</select></label><label className="panel-field">思考强度<select aria-label="探子思考强度" value={thinking} onChange={e => setThinking(e.target.value)}>{['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => <option key={level} value={level}>{level}</option>)}</select></label><button className="primary-button" disabled={pending || !ready || !task.trim()}>{pending ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}派发探子</button><p className="panel-help">{(() => { const entry = roles.find(item => item.id === role); if (!entry) return '权限：读取文件、搜索和列目录。代码修改与最终验证交由主 Agent。'; return entry.writable ? `权限：${(entry.tools || []).join(' / ')}。可写角色在独立 worktree 中运行，改动不会触碰当前工作区；合并由你决定。` : `权限：${(entry.tools || []).join(' / ')}。不可修改文件。`; })()}</p></form>{(worktrees.worktrees || []).length > 1 && <p className="panel-help">当前仓库有 {(worktrees.worktrees || []).length} 个工作树（含主工作树）。隔离工作树在任务详情里可单独移除，分支会保留。</p>}<div className="task-list-filters">
      <input type="search" aria-label="搜索探子任务" placeholder="搜索任务、模型、路径或 ID" maxLength={256} value={options.query} onChange={e => changeFilter({ query: e.target.value })} />
      <select aria-label="筛选探子状态" value={options.status} onChange={e => changeFilter({ status: e.target.value })}><option value="all">全部状态</option><option value="active">进行中</option><option value="completed">已完成</option><option value="attention">需要处理</option></select>
      <select aria-label="筛选归档任务" value={options.archive} onChange={e => changeFilter({ archive: e.target.value })}><option value="current">未归档</option><option value="archived">已归档</option><option value="all">全部记录</option></select>
      <label><input type="checkbox" checked={options.onlyWorkspace} onChange={e => changeFilter({ onlyWorkspace: e.target.checked })} />当前工作区</label>
      <label>每页<select aria-label="每页任务数" value={options.pageSize} onChange={e => changeFilter({ pageSize: Number(e.target.value) })}>{[10,20,50,100].map(size => <option key={size} value={size}>{size} 项</option>)}</select></label>
    </div><nav className="agent-task-list" aria-label="探子任务列表">{visible.map(row => <button className={`agent-task-row ${selected === row.id ? 'selected' : ''}`} data-status={row.status} data-task-id={row.id} key={row.id} onClick={() => setSelected(row.id)}><span className={`task-state ${row.status}`}>{statusLabels[row.status] || row.status}</span><strong>{row.archivedAt ? '已归档 · ' : ''}{row.task}</strong><small>{row.model}</small></button>)}{!visible.length && <p className="panel-empty-note">{listReady ? '这里还没有匹配的任务。' : '正在加载任务…'}</p>}</nav>
    <div className="task-pagination" aria-label="任务分页"><span aria-live="polite">{listReady ? `第 ${data.page} / ${data.totalPages} 页 · ${data.total} 项` : '加载中'}</span><div><button aria-label="上一页任务" disabled={!listReady || data.page <= 1} onClick={() => setOptions(previous => ({ ...previous, page: previous.page - 1 }))}>上一页</button><button aria-label="下一页任务" disabled={!listReady || data.page >= data.totalPages} onClick={() => setOptions(previous => ({ ...previous, page: previous.page + 1 }))}>下一页</button></div></div></aside>
      <section className="agent-task-detail">{detail ? <><div className="task-detail-heading"><div><span className={`task-state ${detail.status}`}>{statusLabels[detail.status] || detail.status}</span><h4>{detail.task}</h4><p>{detail.model} · {detail.thinking} · 第 {detail.attempts} 次运行 · 角色 {detail.role || 'scout'}</p>{detail.worktree && <p className="panel-help">隔离工作树：<code>{detail.branch}</code><button className="text-button" disabled={pending || detail.status === 'running'} onClick={() => void removeWorktree(detail.worktree)}>移除工作树</button></p>}</div><div className="panel-actions">{isActive ? <button className="secondary-button" disabled={pending || detail.status === 'cancelling'} onClick={() => void operate('cancel', detail.id)}><Square size={13} />取消任务</button> : <><button className="secondary-button" disabled={pending || !!detail.archivedAt} onClick={() => void operate('retry', detail.id)}><RotateCcw size={13} />{detail.status === 'completed' ? '重新运行' : '重试任务'}</button>{detail.canResume && <button className="primary-button" disabled={pending} onClick={() => void operate('resume', detail.id)}><Play size={13} />继续会话</button>}</>}{!isActive && (detail.status === 'completed' || detail.archivedAt) && <button className="secondary-button" disabled={pending} onClick={() => void operate(detail.archivedAt ? 'restore' : 'archive', detail.id)}>{detail.archivedAt ? '恢复归档任务' : '归档任务'}</button>}</div>{detail.archivedAt && <p className="panel-help">已归档，会话和结果仍保留。恢复后可重新运行。</p>}</div><div className="task-location"><span title={detail.cwd}>{detail.cwd}</span><button className="text-button" disabled={!detail.canOpenParent || mainBusy} onClick={() => onOpenParent(detail.parentSession)}>查看父会话</button></div><div className="task-usage"><span>输入 <b>{number(detail.usage?.tokens?.input)}</b></span><span>输出 <b>{number(detail.usage?.tokens?.output)}</b></span><span>缓存读取 <b>{number(detail.usage?.tokens?.cacheRead)}</b></span><span>费用 <b>{typeof detail.usage?.cost === 'number' ? `$${detail.usage.cost.toFixed(4)}` : '—'}</b></span></div>{detail.error && <p className="task-error">{detail.error}</p>}<div className="task-output-toolbar"><strong>{full ? '完整结果 · 当前页' : isActive ? '实时输出' : '任务结果预览'}</strong><div><button disabled={!output} onClick={() => void navigator.clipboard.writeText(output).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(error => setError(errorText(error)))}>{copied ? <Check size={13} /> : <Copy size={13} />}{full ? '复制当前页' : '复制'}</button><button disabled={!output} onClick={() => onReference(`探子任务：${detail.task}${full ? `（完整结果第 ${outputIndex + 1} 页）` : ''}\n工作区：${detail.cwd}\n\n${output.slice(0, 32000)}${output.length > 32000 ? '\n[更多结果见子代理工作台]' : ''}`)}>{full ? '引用当前页到消息' : '引用结果到消息'}</button></div></div><pre className="task-output" data-testid="task-output">{output || (isActive ? '等待探子输出…' : '暂无文本输出。')}</pre>{!isActive && <div className="task-output-pages">
      {full ? <><span>第 {outputIndex + 1} 页 · 共 {number(full.totalBytes)} 字节</span><button disabled={outputLoading || outputIndex === 0} onClick={() => void loadOutput(offsets[outputIndex - 1], outputIndex - 1)}>上一页结果</button><button disabled={outputLoading || full.nextOffset == null} onClick={() => void loadOutput(full.nextOffset, outputIndex + 1)}>下一页结果</button><button disabled={outputLoading} onClick={() => void loadOutput(0, 0, true)}>重新加载完整结果</button><button onClick={clearOutput}>返回结果预览</button></> : <button disabled={outputLoading} onClick={() => void loadOutput(0, 0, true)}>查看完整结果</button>}
      {outputLoading && <span role="status">正在读取结果…</span>}
    </div>}{!full && detail.truncated && <p className="panel-help">预览已截取；任务结束后可按页查看子会话中保存的完整文本结果。</p>}{full && <p className="panel-help">展示当前分支已保存的文本回复；复制仅包含当前页，引用最多 32,000 字符。</p>}{detail.tools?.length > 0 && <details className="task-tools"><summary>工具活动 · {detail.tools.length}</summary>{detail.tools.map((tool: Wire) => <div key={tool.id}><strong>{tool.name}</strong><span className={`task-state ${tool.status}`}>{statusLabels[tool.status] || tool.status}</span><code>{tool.args}</code>{tool.output && <pre>{tool.output}</pre>}</div>)}</details>}<div className="task-record-meta">创建于 {date(detail)} · 记录 {detail.id}</div></> : <div className="task-detail-empty"><Users size={32} /><h4>每个探子，独立推进</h4><p>从左侧派发任务，或让主 Agent 调用探子。<br />选择一项任务，查看实时输出和用量。</p><button className="text-button" onClick={() => void refresh()}><RefreshCw size={13} />刷新任务</button></div>}</section></div>
  </div></Modal>;
}
