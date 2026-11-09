import { PermissionControl, ContextControl } from './ComposerStatus';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, Computer, FolderOpen, LoaderCircle, PanelLeftClose, PanelRight, Plus, RefreshCw, ShieldAlert, Square, X, Zap } from './icons';
import { IconButton, Message, Modal } from './components';
import { ComposerModelControl } from './ComposerModelControl';
import type { Attachment, Wire, Model } from './types';
import { acpDraftKey, acpModelWindow, acpOptions, applyAntigravity, emptyAntigravity } from './antigravity.mjs';
import './antigravity.css';
const modeLabels: Record<string,string> = { default: '审核模式', plan: '规划模式', 'accept-edits': '自动编辑' };

export function AntigravityWorkspace({ active, cwd, onBack, onStatus, openContextSignal, leftPanel = true, onToggleLeftPanel, rightPanel = false, onToggleRightPanel }: { openContextSignal?: number; active: boolean; cwd: string; onBack: () => void; onStatus: (status: Wire) => void; leftPanel?: boolean; onToggleLeftPanel?: () => void; rightPanel?: boolean; onToggleRightPanel?: () => void }) {
  const [state, setState] = useState<Wire>(emptyAntigravity), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [executable, setExecutable] = useState(''), [sessions, setSessions] = useState<Wire[]>([]), [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]), [following, setFollowing] = useState(true);
  const alive = useRef(true), scroll = useRef<HTMLDivElement>(null), editor = useRef<HTMLTextAreaElement>(null), inFlight = useRef(false);
  const draftRef = useRef(draft), attachmentsRef = useRef(attachments);
  draftRef.current = draft; attachmentsRef.current = attachments;
  const draftKey = acpDraftKey(state);
  const attachmentDrafts = useRef(new Map<string,Attachment[]>()), previousDraftKey = useRef(draftKey);
  const accept = useCallback((next: Wire) => { if (alive.current) setState(previous => applyAntigravity(previous, next)); }, []);
  const list = useCallback(async () => { try { const result = await window.pi.antigravity({ action: 'list' }); if (alive.current) setSessions(result.sessions || []); } catch { /* A client can still use an agent without session/list. */ } }, []);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.pi.onAntigravity?.(accept);
    void window.pi.antigravity({ action: 'status' }).then(next => { accept(next); setExecutable(next.executable || ''); if (next.connected) void list(); }).catch(error => setError(String(error)));
    return () => { alive.current = false; unsubscribe?.(); };
  }, [accept, list]);
  useEffect(() => {
    try { setDraft(localStorage.getItem(draftKey) || ''); } catch { setDraft(''); }
    attachmentDrafts.current.set(previousDraftKey.current, attachmentsRef.current);
    const restored = attachmentDrafts.current.get(draftKey) || [];
    previousDraftKey.current = draftKey; attachmentsRef.current = restored; setAttachments(restored);
  }, [draftKey]);
  useEffect(() => { onStatus({ busy: state.busy, connecting: state.connecting, permissions: state.permissions.length, connected: state.connected }); }, [state.busy, state.connecting, state.permissions.length, state.connected, onStatus]);
  useEffect(() => { if (editor.current) { editor.current.style.height = 'auto'; editor.current.style.height = `${Math.min(editor.current.scrollHeight, 220)}px`; } }, [draft]);
  useEffect(() => { if (following && active && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [state.messages, state.tools, following, active]);
  const edit = (value: string) => { draftRef.current = value; setDraft(value); try { localStorage.setItem(draftKey, value); } catch {} };
  const call = async (options: Wire) => { const next = await window.pi.antigravity(options); accept(next); return next; };
  const configure = async (configId: string, value: string) => {
    if (inFlight.current) throw new Error('请等待当前操作完成');
    inFlight.current = true; setPending(true); setError('');
    try { await call({ action: 'configure', configId, value }); }
    finally { inFlight.current = false; if (alive.current) setPending(false); }
  };
  const setPermission = async (mode: string, rules?: Wire) => {
    if (inFlight.current) throw new Error('请等待当前操作完成');
    inFlight.current = true; setPending(true); setError('');
    try { await call({action:'set-permission-mode',mode,...(rules?{rules}:{})}); }
    finally { inFlight.current=false; if(alive.current)setPending(false); }
  };
  const operate = async (options: Wire) => {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setError('');
    try { const result = await call(options); if (['connect', 'connect-new', 'new', 'load'].includes(options.action)) { setFollowing(true); await list(); } return result; }
    catch (error) { if (alive.current) setError(String(error)); }
    finally { inFlight.current = false; if (alive.current) setPending(false); }
  };
  const interrupt = async (action = 'cancel') => {
    setError('');
    try { await call({ action }); } catch (error) { if (alive.current) setError(String(error)); }
  };
  const busy = pending || state.busy || state.connecting;
  const connect = (fresh = false) => operate({ action: fresh ? 'connect-new' : 'connect', cwd: state.cwd || cwd, executable });
  const chooseWorkspace = async () => {
    try { const selected = await window.pi.chooseWorkspace(); if (selected) await operate({ action: 'connect', cwd: selected, executable }); }
    catch (error) { setError(String(error)); }
  };
  const add = (items: Attachment[]) => {
    if (!alive.current) return;
    const next = [...attachmentsRef.current, ...items];
    if (next.length > 8) { setError('一次最多添加 8 个附件'); return; }
    attachmentsRef.current = next; setAttachments(next);
  };
  const send = async () => {
    if (busy || !state.connected || !draft.trim() && !attachments.length) return;
    const sentDraft = draft, sentAttachments = attachments;
    const images = attachments.filter(item => item.mimeType).map(item => ({ mimeType: item.mimeType, data: item.data }));
    const text = [draft, ...attachments.filter(item => !item.mimeType).map(item => `\n--- 附件：${item.name} ---\n${item.text}\n--- 附件结束 ---`)].filter(Boolean).join('\n');
    const accepted = await operate({ action: 'prompt', text, images });
    if (accepted) { if (draftRef.current === sentDraft) edit(''); setAttachments(current => current.filter(item => !sentAttachments.includes(item))); setFollowing(true); editor.current?.focus(); }
  };
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[role="dialog"]')) return;
      if (event.key === 'Escape' && state.busy) { event.preventDefault(); void interrupt(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && state.connected && !busy) { event.preventDefault(); void operate({ action: 'new' }); }
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  });
  const modelOption = state.configOptions.find((option: Wire) => option.category === 'model' || option.id === 'model');
  const thought = state.configOptions.find((option: Wire) => ['thought_level', 'thought', 'thinking_level', 'reasoning_effort'].includes(option.category || option.id));
  const models: Model[] = acpOptions(modelOption).map((option: Wire) => ({ id: option.value, name: option.name, provider: 'antigravity', reasoning: !!thought, input: ['text', 'image'], contextWindow: acpModelWindow(option.value) }));
  const mode = state.configOptions.find((option: Wire) => option.category === 'mode');
  const permission = state.permissions[0];
  const currentCwd = state.cwd || cwd;
  return <main className={`main-area antigravity-main ${!active ? 'backend-hidden' : ''}`} aria-label="Antigravity 会话">
    <header className="conversation-header">{onToggleLeftPanel && <IconButton label={leftPanel ? '收起侧栏' : '展开侧栏'} onClick={onToggleLeftPanel}><PanelLeftClose size={18}/></IconButton>}<button className="text-button" onClick={onBack}>返回 Pi</button><strong>Antigravity</strong><span className="acp-status"><i className={`status-dot ${state.busy ? 'busy' : ''}`} />{state.permissions.length ? '等待确认' : state.connecting ? '连接中' : state.busy ? state.cancelling ? '正在停止' : '运行中' : state.connected ? '已连接' : '未连接'}</span>{state.connected && <div className="acp-header-session"><select aria-label="Antigravity 历史会话" value="" disabled={busy} onChange={event => { if (event.target.value) void operate({ action: 'load', sessionId: event.target.value }); }}><option value="">{state.sessionId ? `历史会话 · ${state.sessionId.slice(0, 8)}` : '历史会话'}</option>{sessions.map(session => <option value={session.sessionId} key={session.sessionId}>{session.title || session.sessionId}</option>)}</select><IconButton label="刷新 Antigravity 会话" disabled={busy} onClick={() => void list()}><RefreshCw size={14}/></IconButton></div>}<div className="header-actions">{state.connecting && <button className="text-button" onClick={() => void interrupt('disconnect')}>取消连接</button>}{state.connected ? <><button className="text-button" disabled={busy} onClick={() => void operate({ action: 'new' })}><Plus size={15}/>新会话</button><button className="text-button" onClick={() => void interrupt('disconnect')}>断开</button></> : <button className="secondary-button" disabled={busy || !currentCwd} onClick={() => void connect()}>{state.connecting ? <LoaderCircle size={14} className="spin"/> : <Zap size={14}/>}{state.sessionId ? '恢复会话' : '连接 CLI'}</button>}{!state.connected && state.sessionId && <button className="text-button" disabled={busy} title="连接 CLI 并创建新会话" onClick={() => void connect(true)}>新会话</button>}{onToggleRightPanel && <IconButton label="文件与改动" onClick={onToggleRightPanel} className={rightPanel ? 'selected' : ''}><PanelRight size={18}/></IconButton>}</div></header>
    <div className="conversation-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 120); }}>
      {state.messages.length ? <div className="transcript">{state.messages.map((message: Wire) => <Message allowFileLinks={false} agentName="Antigravity" key={message._key} message={message} tools={state.tools}/>)}{state.busy && <div className="working-indicator"><LoaderCircle size={14} className="spin"/>{state.permissions.length ? '等待工具权限确认' : 'Antigravity 正在处理'}</div>}</div> : <div className="acp-welcome"><Zap size={30}/><h1>{state.connected ? '和 Antigravity 开始对话' : '连接 Antigravity CLI'}</h1>{!state.connected && <><button className="primary-button" disabled={busy || !currentCwd} onClick={() => void connect()}>{state.sessionId ? '恢复会话' : '连接已有登录'}</button><details className="diagnostics acp-connection"><summary>连接设置</summary><label>CLI 路径<input aria-label="Antigravity CLI 路径" value={executable} onChange={event => setExecutable(event.target.value)}/></label><button className="secondary-button" disabled={busy} onClick={() => { void window.pi.antigravity({ action: 'choose-executable' }).then(path => { if (path) setExecutable(String(path)); }).catch(error => setError(String(error))); }}>选择 agy.exe</button></details></>}</div>}
    </div>
    <div className="composer-area">{state.warning && !error && !state.error && <div role="status" className="notice"><ShieldAlert size={16}/><div>{state.warning}</div></div>}{(error || state.error) && <div role="alert" className="notice error"><ShieldAlert size={16}/><div>{error || state.error}</div></div>}{!following && state.messages.length > 0 && <button className="jump-bottom" onClick={() => setFollowing(true)}>回到最新</button>}<div className="composer-context"><button className="composer-project" disabled={busy} onClick={() => void chooseWorkspace()} title={currentCwd}><FolderOpen size={15}/><span>{currentCwd.split(/[\\/]/).pop()}</span></button><span className="composer-computer"><Computer size={17}/>此计算机</span></div><div className="composer">
      {attachments.length > 0 && <div className="attachments">{attachments.map((item, index) => <div className="attachment" key={`${item.name}-${index}`}><span>{item.name}</span><IconButton label={`移除 Antigravity 附件 ${item.name}`} onClick={() => setAttachments(items => items.filter((_, itemIndex) => itemIndex !== index))}><X size={13}/></IconButton></div>)}</div>}
      <textarea ref={editor} aria-label="Antigravity 消息" placeholder="随心输入" rows={2} value={draft} disabled={!state.connected || state.connecting} onChange={event => edit(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } }} onPaste={event => { const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); void Promise.all(images.map(file => new Promise<Attachment>((resolve, reject) => { if (file.size > 10 * 1024 * 1024) { reject(new Error('图片超过 10 MB')); return; } const reader = new FileReader(); reader.onload = () => resolve({ name: file.name || 'clipboard.png', size: file.size, mimeType: file.type, data: String(reader.result).split(',')[1] }); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }))).then(add).catch(error => setError(String(error))); } }}/>
      <div className="composer-toolbar"><div className="composer-options"><IconButton label="添加 Antigravity 附件" disabled={!state.connected || busy} onClick={() => { void window.pi.chooseAttachments().then(add).catch(error => setError(String(error))); }}><Plus size={20}/></IconButton><PermissionControl scope="Antigravity" mode={state.permissionMode} rules={state.permissionRules} configFile={state.permissionConfigFile} configError={state.permissionConfigError} locked={busy} onChange={setPermission} onError={error=>setError(String(error))}/>{state.connected && mode && <select className="acp-mode-select" aria-label="Antigravity 模式" value={mode.currentValue} disabled={busy} onChange={event => void operate({ action: 'configure', configId: mode.id, value: event.target.value })}>{acpOptions(mode).map((option: Wire) => <option key={option.value} value={option.value}>{modeLabels[option.value] || option.name}</option>)}</select>}</div><div className="send-controls"><ContextControl openSignal={openContextSignal} scope="Antigravity" usage={state.contextUsage?.modelId===modelOption?.currentValue ? state.contextUsage : null} windowSize={acpModelWindow(modelOption?.currentValue)} stale={state.contextUsage?.stale} busy={state.busy} cost={state.contextUsage?.cost} connected={state.connected}/><ComposerModelControl models={models} model={models.find(model => model.id === modelOption?.currentValue)} levels={acpOptions(thought).map((option: Wire) => option.value)} level={thought?.currentValue || 'off'} ready={state.connected} locked={busy} onModelChange={model => configure(modelOption.id, model.id)} onLevelChange={value => configure(thought.id, value)} onError={error => setError(String(error))}/><button className={`send-button ${state.busy ? 'stop-mode' : ''}`} aria-label={state.busy ? '停止 Antigravity 任务' : '发送 Antigravity 消息'} title={state.busy ? '停止任务 · Esc' : '发送 · Enter'} disabled={state.busy ? state.cancelling : (busy || !state.connected || !draft.trim() && !attachments.length)} onClick={() => void (state.busy ? interrupt() : send())}>{state.busy ? (state.cancelling ? <LoaderCircle size={18} className="spin"/> : <Square size={14} fill="currentColor"/>) : <ArrowUp size={22}/>}</button></div></div></div><div className="composer-footer"><span><span className={`status-dot ${state.busy ? 'busy' : ''}`} />Antigravity CLI{state.agentInfo?.version ? ` v${state.agentInfo.version}` : ''}</span><span><kbd>Enter</kbd> 发送<span className="footer-divider">·</span><kbd>Shift Enter</kbd> 换行</span></div></div>
    {active && permission && <Modal title="Antigravity 工具权限" onClose={() => void operate({ action: 'permission', id: permission.id })}><div className="modal-body"><h3>{permission.toolCall?.title || '工具操作'}</h3><pre className="acp-permission-input">{JSON.stringify(permission.toolCall?.rawInput || permission.toolCall, null, 2)}</pre><div className="modal-actions">{(permission.options || []).map((option: Wire) => <button key={option.optionId} className={option.kind?.startsWith('allow') ? 'primary-button' : 'secondary-button'} disabled={pending || state.cancelling} onClick={() => void operate({ action: 'permission', id: permission.id, optionId: option.optionId })}>{option.name}</button>)}<button className="secondary-button" disabled={pending} onClick={() => void interrupt()}>停止任务</button></div></div></Modal>}
  </main>;
}
