import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowDown, ArrowUpRight, Brain, Check, ChevronDown, ChevronRight, CircleAlert, Code2, FilePlus2, Folder, FolderOpen, GitBranch, Layers, LoaderCircle, Maximize2, MessageSquare, Minus, MoreHorizontal, PanelLeftClose, PanelRight, Paperclip, Plus, RefreshCw, Search, Settings2, Sparkles, Square, Terminal, X, Download, Plug, ShieldAlert } from 'lucide-react';
import type { Attachment, Changes, FileEntry, Preferences, Preview, Session, Snapshot, Wire } from './types';
import { emptyTranscript, loadTranscript, reduceTranscript } from './transcript.mjs';
import { ExtensionDialog, FileTree, IconButton, Message, Modal, PiMark } from './components';
import { FilePreview, McpPanel } from './ReviewPanel';
import { ContextPanel, AgentsPanel } from './WorkspacePanels';
import { changeGroups } from './workflows.mjs';
import { useComposerCompletions } from './ComposerCompletions';
import './styles.css';
import './workflows.css';

const basename = (value: string) => value?.split(/[\\/]/).filter(Boolean).pop() || '工作区';
const samePath = (a?: string, b?: string) => a?.replace(/\\/g, '/').toLowerCase() === b?.replace(/\\/g, '/').toLowerCase();
const thinkingNames: Record<string, string> = { off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
const cleanAnsi = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const draftKey = (cwd: string, state: Wire) => `pi-draft:${cwd}:${state.sessionId || 'new'}`;
const readDraft = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };

export default function App() {
  const [preferences, setPreferences] = useState<Preferences>({ executable: '', lastWorkspace: '' });
  const [agentDirectory, setAgentDirectory] = useState('');
  const [appVersion, setAppVersion] = useState('0.4.1');
  const [workspacePanel, setWorkspacePanel] = useState<'context' | 'agents' | null>(null);
  const [mcpOpen,setMcpOpen]=useState(false);
  const [recovery,setRecovery]=useState<Wire|null>(null);
  const [conflict,setConflict]=useState<{path:string;reason:string}|null>(null);
  const [references,setReferences]=useState<string[]>([]);
  const [review,setReview]=useState<Wire|null>(null);
  const [previewLine,setPreviewLine]=useState(1);
  const [cwd, setCwd] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [transcript, setTranscript] = useState<Wire>(emptyTranscript());
  const [connection, setConnection] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [search, setSearch] = useState('');
  const [allSessions, setAllSessions] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [queueMode, setQueueMode] = useState('steer');
  const [queue, setQueue] = useState<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] });
  const [status, setStatus] = useState('');
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [widgets, setWidgets] = useState<Record<string, string[]>>({});
  const [dialogs, setDialogs] = useState<Wire[]>([]);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [settings, setSettings] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Wire>({});
  const [trust, setTrust] = useState(false);
  const [rightPanel, setRightPanel] = useState(true);
  const [leftPanel, setLeftPanel] = useState(true);
  const [panelTab, setPanelTab] = useState('files');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [changes, setChanges] = useState<Changes>({ available: false, branch: '', files: [] });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [following, setFollowing] = useState(true);
  const [showAllMessages, setShowAllMessages] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const generation = useRef(0), eventRevision = useRef(0), changing = useRef(false);
  const latestEvent = useRef<(event: Wire) => void>(() => {});
  const running = !!transcript.running;
  const locked = running || submitting || actionPending || connection === 'connecting';
  const ready = connection === 'ready';
  const state = snapshot?.state || {};
  const title = state.sessionName || sessions.find(s => s.id === state.sessionId)?.name || '新会话';
  const showError = useCallback((error: unknown) => setNotice({ text: errorText(error), error: true }), []);

  const completion = useComposerCompletions({
    draft, setDraft, ready, scope: `${cwd}:${snapshot?.generation ?? 0}`, commands: snapshot?.commands || [], editor,
    onReference: file => {
      if (references.length >= 8 && !references.includes(file.path)) { showError('一次最多引用 8 个文件'); return false; }
      setReferences(previous => [...new Set([...previous, file.path])]);
      return true;
    },
  });

  const [fileTreeRevision,setFileTreeRevision]=useState(0);
  const refreshFiles = async () => {
    setFileTreeRevision(n=>n+1);
    const current = generation.current;
    const results = await Promise.allSettled([window.pi.files(), window.pi.changes()]);
    if (current !== generation.current) return;
    if (results[0].status === 'fulfilled') setFiles(results[0].value); else showError(results[0].reason);
    if (results[1].status === 'fulfilled') setChanges(results[1].value); else showError(results[1].reason);
  };
  const refreshSessions = async (workspace?: string) => {
    try { setSessions(await window.pi.sessions(workspace)); } catch (error) { showError(error); }
  };
  const refreshSnapshot = async () => {
    const current = generation.current, revision = eventRevision.current;
    try {
      const next = await window.pi.snapshot();
      if (current !== generation.current || changing.current) return;
      setSnapshot(next);
      if (revision === eventRevision.current) setTranscript(loadTranscript(next.messages, next.state.isStreaming || next.state.isCompacting));
    } catch (error) { showError(error); }
  };
  const connect = async (options: { cwd?: string; sessionPath?: string; trust?: boolean; fork?: boolean; preserveDraft?: boolean } = {}) => {
    if (changing.current) return;
    changing.current = true;
    if(options.sessionPath&&!options.fork&&window.pi.sessionAccess){
      try{const access=await window.pi.sessionAccess(options.sessionPath);if(!access.available){setConflict({path:options.sessionPath,reason:access.reason});changing.current=false;return;}}catch(error){showError(error);changing.current=false;return;}
    }
    const previousConnection=connection;
    const preserveDraft = options.preserveDraft ?? (!!options.sessionPath && samePath(options.sessionPath, state.sessionFile));
    setConnection('connecting'); setStatus('正在连接本地 Pi'); setNotice(null); setMore(false);
    setDialogs([]); setStatuses({}); setWidgets({}); setQueue({ steering: [], followUp: [] });
    try {
      const next = await window.pi.connect(options);
      generation.current = next.generation;
      setCwd(next.cwd); setSnapshot(next); setTranscript(loadTranscript(next.messages, next.state.isStreaming || next.state.isCompacting));
      if(!preserveDraft){setDraft(readDraft(draftKey(next.cwd,next.state)));setAttachments([]);setReferences([]);}
      setShowAllMessages(false);setConflict(null);setRecovery(null);
      setConnection('ready'); setStatus(''); setFollowing(true);
      setPreferences(p => ({ ...p, lastWorkspace: next.cwd, recentWorkspaces: [next.cwd, ...(p.recentWorkspaces || []).filter(w => !samePath(w, next.cwd))].slice(0, 12) }));
      void refreshSessions(next.cwd); void refreshFiles();
    } catch (error) {
      const message=errorText(error);
      if(message.includes('SESSION_BUSY:')&&options.sessionPath){setConflict({path:options.sessionPath,reason:message});setConnection(previousConnection);}
      else{setConnection('error');setStatus('连接失败');showError(error);}
    }
    finally { changing.current = false; }
  };
  latestEvent.current = (event: Wire) => {
    setTranscript((previous: any) => reduceTranscript(previous, event));
    if (event.type === 'agent_start') setStatus('等待模型回复');
    if(event.type==='message_update'&&event.assistantMessageEvent?.type==='text_delta')setStatus('正在生成回复');
    if (event.type === 'tool_execution_start') setStatus(`正在执行 ${event.toolName}`);
    if (event.type === 'agent_settled') { setStatus(event.aborted ? '已停止' : ''); void refreshSnapshot(); void refreshSessions(cwd); void refreshFiles(); }
    if (event.type === 'queue_update') setQueue({ steering: event.steering || [], followUp: event.followUp || [] });
    if (event.type === 'compaction_start') setStatus('正在压缩上下文');
    if (event.type === 'compaction_end') { setStatus(''); void refreshSnapshot(); if (event.errorMessage) showError(event.errorMessage); }
    if (event.type === 'auto_retry_start') setStatus(`正在重试 (${event.attempt}/${event.maxAttempts})`);
    if (event.type === 'auto_retry_end' && !event.success) showError(event.finalError);
    if (event.type === 'session_info_changed') setSnapshot(s => s ? { ...s, state: { ...s.state, sessionName: event.name } } : s);
    if (event.type === 'thinking_level_changed') setSnapshot(s => s ? { ...s, state: { ...s.state, thinkingLevel: event.level } } : s);
    if (event.type === 'transport_exit') { setConnection('error'); setStatus('Pi 已断开'); setDialogs([]); showError(event.message); setRecovery({sessionPath:state.sessionFile,cwd,interrupted:true}); }
    if (event.type === 'extension_error') showError(`扩展 ${basename(event.extensionPath)}：${event.error}`);
    if (event.type === 'transport_warning') showError(event.message);
    if (event.type === 'dialog_expired') setDialogs(ds => ds.filter(d => d.id !== event.id));
    if (event.type === 'dialogs_cleared') setDialogs([]);
    if (event.type === 'extension_ui_request') {
      if (['select', 'confirm', 'input', 'editor'].includes(event.method)) {setDialogs(ds => [...ds, event]);setStatus('等待你的输入');}
      if (event.method === 'notify') setNotice({ text: cleanAnsi(event.message || ''), error: event.notifyType === 'error' });
      if (event.method === 'setStatus') setStatuses(s => ({ ...s, [event.statusKey]: cleanAnsi(event.statusText || '') }));
      if (event.method === 'setWidget') setWidgets(w => ({ ...w, [event.widgetKey]: (event.widgetLines || []).map(cleanAnsi) }));
      if (event.method === 'set_editor_text') setDraft(event.text || '');
    }
  };

  useEffect(() => {
    const unsubscribe = window.pi.onEvent(({ generation: nextGeneration, event }) => {
      if (nextGeneration < generation.current) return;
      generation.current = nextGeneration;
      eventRevision.current++;
      latestEvent.current(event);
    });
    void window.pi.bootstrap().then(data => {
      setPreferences(data.preferences); setAgentDirectory(data.agentDir); setAppVersion(data.version);
      setCwd(data.preferences.lastWorkspace);
      setRecovery(data.recovery||null);
      void connect({ cwd: data.preferences.lastWorkspace }).then(()=>setRecovery(data.recovery||null));
    }).catch(showError);
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (snapshot && connection!=='connecting') { try { localStorage.setItem(draftKey(cwd, snapshot.state), draft); } catch {} }
  }, [draft, cwd, snapshot?.state.sessionId, ready]);
  useEffect(() => {
    if (editor.current) { editor.current.style.height = 'auto'; editor.current.style.height = `${Math.min(editor.current.scrollHeight, 220)}px`; }
  }, [draft]);
  useEffect(() => {
    if (following && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [transcript.messages, transcript.tools, following, status]);
  useEffect(() => {
    if (settings) void window.pi.diagnostics().then(setDiagnostics).catch(showError);
  }, [settings]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || document.querySelector('[role="dialog"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!locked) void connect({ cwd }); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); if (!locked) void chooseWorkspace(); }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); setSettings(true); }
      if (e.key === 'Escape' && running) { e.preventDefault(); void stop(); }
    };
    document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler);
  });

  const chooseWorkspace = async () => { try { const selected = await window.pi.chooseWorkspace(); if (selected) await connect({ cwd: selected }); } catch (error) { showError(error); } };
  const addAttachments = (incoming: Attachment[]) => setAttachments(previous => {
    if (previous.length + incoming.length > 8 || [...previous, ...incoming].reduce((sum, a) => sum + a.size, 0) > 20 * 1024 * 1024) { showError('一次最多 8 个附件，总大小不超过 20 MB。'); return previous; }
    return [...previous, ...incoming];
  });
  const chooseAttachments = async () => { try { addAttachments(await window.pi.chooseAttachments()); } catch (error) { showError(error); } };
  const pasteImages = async (files: File[]) => {
    try {
      const incoming = await Promise.all(files.map(file => new Promise<Attachment>((resolve, reject) => {
        if (file.size > 20 * 1024 * 1024) return reject(new Error('图片超过 20 MB。'));
        if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return reject(new Error('支持 PNG、JPEG、GIF 和 WebP 图片。'));
        const reader = new FileReader(); reader.onerror = () => reject(new Error('无法读取图片'));
        reader.onload = () => resolve({ name: file.name || '粘贴图片.png', size: file.size, mimeType: file.type, data: String(reader.result).split(',')[1] });
        reader.readAsDataURL(file);
      })));
      addAttachments(incoming);
    } catch (error) { showError(error); }
  };
  const send = async () => {
    if (!ready || submitting || actionPending || (!draft.trim() && !attachments.length)) return;
    const original = draft, originalAttachments = attachments, originalReferences=references;
    if (draft.trim() === '/settings') { setSettings(true); setDraft(''); return; }
    if (draft.trim() === '/new' && !running) { await connect({ cwd }); return; }
    if (/^\/(login|logout|resume|tree|hotkeys|trust)(\s|$)/.test(draft.trim())) { showError('该命令需要 Pi 终端界面。会话切换请用左侧列表；登录与持久信任设置请在 Pi CLI 中完成。'); return; }
    const images = attachments.filter(a => a.mimeType).map(a => ({ type: 'image', mimeType: a.mimeType, data: a.data }));
    if (images.length && !state.model?.input?.includes('image')) { showError('当前模型不支持图片，请切换到支持图片的模型。'); return; }
    const textFiles = attachments.filter(a => a.text !== undefined).map(a => `\n\n--- 附件：${a.path || a.name} ---\n${a.text}\n--- 附件结束 ---`).join('');
    setSubmitting(true); setDraft(''); setAttachments([]); setReferences([]); setNotice(null); setFollowing(true);
    try {
      const response = await window.pi.command('prompt', { message: `${original.trim() || '请查看附件。'}${textFiles}`, references:originalReferences, ...(images.length ? { images } : {}), ...(running ? { streamingBehavior: queueMode } : {}) });
      if (response?.disposition === 'handled') { setStatus(''); void refreshSnapshot(); }
    } catch (error) {
      setDraft(current => current ? `${original}\n${current}` : original); setAttachments(current => [...originalAttachments, ...current]);setReferences(current=>[...new Set([...originalReferences,...current])]);showError(error);
      if(errorText(error).includes('SESSION_CHANGED:')&&state.sessionFile)setConflict({path:state.sessionFile,reason:errorText(error)});
    } finally { setSubmitting(false); editor.current?.focus(); }
  };
  const stop = async () => {
    setActionPending(true);
    try {
      const returned = await window.pi.stop();
      const restored = [...returned.steering, ...returned.followUp].join('\n\n');
      if (restored) setDraft(current => [current, restored].filter(Boolean).join('\n\n'));
      setQueue({ steering: [], followUp: [] }); setStatus('已停止');
      await refreshSnapshot();
    } catch (error) { showError(error); } finally { setActionPending(false); }
  };
  const change = async (type: string, data?: Wire) => {
    setActionPending(true);
    try { await window.pi.command(type, data); await refreshSnapshot(); if (type === 'set_session_name') void refreshSessions(cwd); }
    catch (error) { showError(error); } finally { setActionPending(false); }
  };
  const openPreview = async (file: string, diff = false, stage:'working'|'staged'='working',line=1) => {
    try {setPreviewLine(line);if(diff&&window.pi.review){const result=await window.pi.review(file,stage);setReview(result);setPreview({path:file,content:result.new.content,diff:true});}else{setReview(null);setPreview(await window.pi.preview(file));}}catch(error){showError(error);}
  };
  useEffect(()=>{const handler=(event:Event)=>{const detail=(event as CustomEvent).detail;void openPreview(detail.path,false,'working',detail.line);};window.addEventListener('pi:open-file',handler);return()=>window.removeEventListener('pi:open-file',handler);},[cwd]);
  useEffect(() => window.pi.onFileDrop?.(event => {
    setDragging(event.type === 'enter' || event.type === 'over');
    if (event.type === 'drop' && event.paths?.length) {
      void window.pi.attachments(event.paths).then(addAttachments).catch(showError);
    }
  }), []);
  const visibleSessions = sessions.filter(session => (allSessions || samePath(session.cwd, cwd)) && `${session.name} ${session.cwd}`.toLowerCase().includes(search.toLowerCase()));
  const visibleMessages = transcript.messages.filter((m: Wire) => m.role !== 'system' && m.role !== 'toolResult' && m.display !== false);
  const displayedMessages = showAllMessages ? visibleMessages : visibleMessages.slice(-100);
  const pendingCount = queue.steering.length + queue.followUp.length;
  const context = snapshot?.stats?.contextUsage;

  return <div className={`app-shell ${leftPanel ? '' : 'no-sidebar'} ${rightPanel ? '' : 'no-inspector'}`}>
    <div className="titlebar" data-tauri-drag-region><div className="app-brand"><PiMark small /><span>Pi Desktop</span><span className="preview-label">LOCAL</span></div><div className="titlebar-center">你的想法，本地的工作空间</div><div className="window-controls"><button aria-label="最小化" onClick={() => void window.pi.window('minimize')}><Minus size={16} /></button><button aria-label="最大化" onClick={() => void window.pi.window('maximize')}><Maximize2 size={13} /></button><button aria-label="关闭窗口" className="close-window" onClick={() => void window.pi.window('close')}><X size={17} /></button></div></div>
    {leftPanel && <aside className="sidebar"><div className="sidebar-top"><button className="new-chat" onClick={() => void connect({ cwd })} disabled={locked}><Plus size={18} /><span>新会话</span><kbd>Ctrl N</kbd></button><div className="search-box"><Search size={15} /><input aria-label="搜索会话" placeholder="搜索会话" value={search} onChange={e => setSearch(e.target.value)} /><kbd>⌕</kbd></div></div>
      <div className="workspace-label"><span>工作区</span><IconButton label="添加工作区" disabled={locked} onClick={() => void chooseWorkspace()}><Plus size={15} /></IconButton></div>
      <button className="workspace-current" onClick={() => void chooseWorkspace()} disabled={locked} title={cwd}><span className="workspace-icon"><FolderOpen size={18} /></span><span><strong>{basename(cwd)}</strong><small>{cwd || '选择一个文件夹'}</small></span><ChevronDown size={14} /></button>
      {(preferences.recentWorkspaces || []).filter(item => !samePath(item, cwd)).slice(0, 3).map(item => <button className="recent-workspace" key={item} onClick={() => void connect({ cwd: item })} disabled={locked} title={item}><Folder size={15} />{basename(item)}</button>)}
      <div className="session-label"><span>{allSessions ? '全部会话' : '当前工作区会话'}</span><button onClick={() => setAllSessions(!allSessions)}>{allSessions ? '当前' : '全部'}</button></div>
      <nav className="session-list" aria-label="历史会话">{visibleSessions.length ? visibleSessions.map(session => <button key={session.path} className={`session-item ${session.id === state.sessionId ? 'active' : ''}`} disabled={locked} onClick={() => void connect({ sessionPath: session.path })} title={`${session.name}\n${session.cwd}`}><MessageSquare size={14} /><span><strong>{session.name}</strong>{allSessions && <small>{basename(session.cwd)}</small>}</span><small className="session-date">{new Date(session.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</small></button>) : <div className="session-empty"><MessageSquare size={22} /><p>{search ? '没有找到匹配的会话' : '从一个新想法开始'}</p><span>{search ? '试试其他关键词' : '对话会自动保存在本机'}</span></div>}</nav>
      <div className="workspace-tools"><button aria-label="上下文管理" disabled={!ready} onClick={()=>setWorkspacePanel('context')}><Brain size={15}/>上下文</button><button aria-label="子代理工作台" onClick={()=>setWorkspacePanel('agents')}><Layers size={15}/>子代理</button></div>
      <div className="sidebar-footer"><div className={`connection-pill ${connection}`}><span className="status-dot" />{connection === 'ready' ? 'Pi 本地已连接' : connection === 'connecting' ? '正在连接 Pi…' : 'Pi 未连接'}<span>RPC</span></div><button className="settings-button" onClick={()=>setMcpOpen(true)} disabled={!ready||locked}><Plug size={17}/><span>MCP 连接</span></button><button className="settings-button" onClick={() => setSettings(true)}><Settings2 size={17} /><span>设置与连接</span><kbd>Ctrl ,</kbd></button></div>
    </aside>}
    <main className="main-area"><header className="conversation-header"><IconButton label={leftPanel ? '收起侧栏' : '展开侧栏'} onClick={() => setLeftPanel(!leftPanel)}><PanelLeftClose size={18} /></IconButton><div className="breadcrumb"><span>{basename(cwd)}</span><ChevronRight size={13} /><strong title={title}>{title}</strong></div><div className="header-actions">{changes.available && <span className="branch-badge"><GitBranch size={13} />{changes.branch}</span>}<button className="text-button open-folder" onClick={() => void window.pi.revealWorkspace().catch(showError)}><FolderOpen size={15} />打开文件夹<ArrowUpRight size={13} /></button><IconButton label="文件与改动" onClick={() => setRightPanel(!rightPanel)} className={rightPanel ? 'selected' : ''}><PanelRight size={18} /></IconButton><div className="menu-anchor"><IconButton label="会话操作" onClick={() => setMore(!more)}><MoreHorizontal size={19} /></IconButton>{more && <div className="dropdown-menu"><button disabled={locked || !ready} onClick={() => { setMore(false); setRenameValue(title); }}><MessageSquare size={15} />重命名会话</button><button disabled={locked || !ready} onClick={() => { setMore(false); void window.pi.exportSession().then(result => { if (result) setNotice({ text: `会话已导出：${result}` }); }).catch(showError); }}><Download size={15} />导出 HTML</button><button disabled={locked || !ready} onClick={() => { setMore(false); void change('compact'); }}><Layers size={15} />压缩上下文</button></div>}</div></div></header>
      <div className="conversation-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}>
        {visibleMessages.length === 0 ? <div className="welcome"><div className="welcome-badge"><PiMark /></div><div className="eyebrow">一个想法，无限可能</div><h1>今天，一起做点什么？</h1><p>从一个问题、一段代码，或一个全新的项目开始。<br />Pi 已准备好与你一起工作。</p><div className="suggestions">{[
          { icon: <Code2 size={20} />, title: '了解这个项目', desc: '梳理结构，找到开始的地方', prompt: '请先只读查看当前项目，介绍它的用途、主要目录和推荐的运行方式。' },
          { icon: <Sparkles size={20} />, title: '实现一个想法', desc: '把想法变成能运行的代码', prompt: '我想在这个项目里实现一个功能：' },
          { icon: <GitBranch size={20} />, title: '检查代码改动', desc: '找出问题，让改动更可靠', prompt: '请只读审查当前工作区的 Git 改动，重点指出真实缺陷、潜在回归和缺少的验证。' },
        ].map(suggestion => <button key={suggestion.title} className="suggestion-card" onClick={() => { setDraft(suggestion.prompt); editor.current?.focus(); }}><span className="suggestion-icon">{suggestion.icon}</span><strong>{suggestion.title}<ArrowUpRight size={15} /></strong><small>{suggestion.desc}</small></button>)}</div><div className="welcome-workspace"><Folder size={13} /><span title={cwd}>{cwd}</span></div></div> : <div className="transcript">{visibleMessages.length > 100 && !showAllMessages && <button className="load-earlier" onClick={() => setShowAllMessages(true)}>显示更早的 {visibleMessages.length - 100} 条消息</button>}{displayedMessages.map((message: Wire) => <Message key={message._key} message={message} tools={transcript.tools} />)}{running && <div className="working-indicator"><span className="working-dots"><i /><i /><i /></span>{status || 'Pi 正在处理'}</div>}</div>}
      </div>
      <div className="composer-area">{recovery?.sessionPath&&<div className="recovery-banner"><ShieldAlert size={16}/><span>{recovery.interrupted?'上次任务被中断，可恢复已保存的会话。':'可继续上次保存的会话。'}</span><button disabled={locked} onClick={()=>void connect({sessionPath:recovery.sessionPath,preserveDraft:connection==='error'})}>恢复会话</button><button onClick={()=>setRecovery(null)} aria-label="忽略恢复提示"><X size={14}/></button></div>}{!following && visibleMessages.length > 0 && <button className="jump-bottom" onClick={() => setFollowing(true)}><ArrowDown size={14} />回到最新</button>}
        {notice && <div role={notice.error ? 'alert' : 'status'} className={`notice ${notice.error ? 'error' : ''}`}><span>{notice.error ? <CircleAlert size={16} /> : <Check size={16} />}</span><div>{notice.text}</div><IconButton label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></IconButton></div>}
        {Object.values(widgets).some(lines => lines.length > 0) && <div className="extension-widgets">{Object.entries(widgets).map(([key, lines]) => lines.length ? <pre key={key}>{lines.join('\n')}</pre> : null)}</div>}
        {pendingCount > 0 && <div className="queue-banner"><Layers size={14} /><span>{queue.steering.length} 条补充指令 · {queue.followUp.length} 条后续消息</span><button onClick={() => { void window.pi.command('clear_queue').then((result: Wire) => { const restored = [...result.steering, ...result.followUp].join('\n\n'); setDraft(current => [current, restored].filter(Boolean).join('\n\n')); }).catch(showError); }}>取回编辑</button></div>}
        <div className={`composer ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={e => { e.preventDefault(); setDragging(false); const paths = Array.from(e.dataTransfer.files).map(f => window.pi.pathForFile(f)).filter(Boolean); void window.pi.attachments(paths).then(addAttachments).catch(showError); }}>
          {completion.menu}
          {references.length>0&&<div className="reference-chips">{references.map(path=><span key={path}><FilePlus2 size={13}/>{path}<button aria-label={`移除引用 ${path}`} onClick={()=>setReferences(items=>items.filter(p=>p!==path))}><X size={12}/></button></span>)}<small>发送时附带文件文本</small></div>}
          {attachments.length > 0 && <div className="attachments">{attachments.map((attachment, index) => <div className="attachment" key={`${attachment.name}-${index}`}>{attachment.mimeType ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /> : <FilePlus2 size={18} />}<span>{attachment.name}<small>{Math.max(1, Math.round(attachment.size / 1024))} KB</small></span><IconButton label={`移除 ${attachment.name}`} onClick={() => setAttachments(items => items.filter((_, i) => i !== index))}><X size={13} /></IconButton></div>)}</div>}
          <textarea ref={editor} {...completion.inputProps} aria-label="消息" placeholder={dragging ? '放开以添加文件或图片' : running ? '补充要求，或安排接下来的任务…' : '描述你的想法，或输入 / 使用技能与命令…'} rows={2} value={draft} onKeyDown={e => { if(e.nativeEvent.isComposing||e.keyCode===229)return;if(completion.onKeyDown(e))return; if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send(); } }} onPaste={e => { const images = Array.from(e.clipboardData.files).filter(file => file.type.startsWith('image/')); if (images.length) { e.preventDefault(); void pasteImages(images); } }} />
          <div className="composer-toolbar"><div className="composer-options"><IconButton label="添加附件" onClick={() => void chooseAttachments()}><Plus size={19} /></IconButton><span className="toolbar-divider" /><div className="model-select"><Code2 size={14} /><select aria-label="选择模型" disabled={!ready || locked} value={state.model ? `${state.model.provider}::${state.model.id}` : ''} onChange={e => { const selected = snapshot?.models.find(model => `${model.provider}::${model.id}` === e.target.value); if (selected) void change('set_model', { provider: selected.provider, modelId: selected.id }); }}>{!state.model && <option value="">选择模型</option>}{snapshot?.models.map(model => <option key={`${model.provider}::${model.id}`} value={`${model.provider}::${model.id}`}>{model.name || model.id} · {model.provider}</option>)}</select><ChevronDown size={12} /></div><div className="thinking-select"><Brain size={14} /><select aria-label="思考强度" disabled={!ready || locked} value={state.thinkingLevel || 'off'} onChange={e => void change('set_thinking_level', { level: e.target.value })}>{(snapshot?.levels || ['off']).map(level => <option key={level} value={level}>{thinkingNames[level] || level}</option>)}</select><ChevronDown size={12} /></div></div><div className="send-controls">{running && <select className="queue-select" aria-label="发送方式" value={queueMode} onChange={e => setQueueMode(e.target.value)}><option value="steer">补充指令</option><option value="followUp">完成后发送</option></select>}{running && <IconButton label="停止任务" disabled={actionPending} onClick={() => void stop()} className="stop-button"><Square size={15} fill="currentColor" /></IconButton>}<button className="send-button" aria-label="发送消息" title="发送 · Enter" onClick={() => void send()} disabled={!ready || submitting || actionPending || (!draft.trim() && !attachments.length)}>{submitting ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={20} />}</button></div></div>
        </div>
        <div className="composer-footer"><span><span className={`status-dot ${running ? 'busy' : ''}`} />{running ? status || '处理中' : connection === 'connecting' ? '正在连接…' : ready ? '本地工作区' : '未连接'}{Object.values(statuses).filter(Boolean).slice(0, 1).map(text => <span className="extension-status" key={text} title={text}> · {text}</span>)}</span>{connection === 'error' ? <button onClick={() => void connect({ cwd, sessionPath: state.sessionFile, preserveDraft:true })}>重新连接</button> : <span>{context?.percent != null && <span title={`${context.tokens?.toLocaleString()} / ${context.contextWindow?.toLocaleString()} tokens`}>上下文 {Math.round(context.percent)}%<span className="footer-divider">·</span></span>}<kbd>Enter</kbd> 发送<span className="footer-divider">·</span><kbd>Shift Enter</kbd> 换行</span>}</div>
      </div>
    </main>
    {rightPanel && <aside className="inspector"><header><div className="panel-tabs"><button className={panelTab === 'files' ? 'active' : ''} onClick={() => setPanelTab('files')}>文件</button><button className={panelTab === 'changes' ? 'active' : ''} onClick={() => setPanelTab('changes')}>改动{changes.files.length > 0 && <span>{changes.files.length}</span>}</button></div><IconButton label="刷新文件" disabled={!ready} onClick={() => void refreshFiles()}><RefreshCw size={14} /></IconButton></header><div className="inspector-subtitle"><Folder size={13} /><strong>{basename(cwd)}</strong><span>{panelTab === 'files' ? '工作区' : changes.branch}</span></div><div className="inspector-content">{panelTab === 'files' ? <FileTree key={`${cwd}:${fileTreeRevision}`} entries={files} onOpen={file => void openPreview(file)} onError={showError} /> : !changes.available ? <div className="panel-empty"><GitBranch size={28} /><strong>这里还没有 Git 仓库</strong><p>{changes.reason || '选择一个 Git 项目，即可查看文件改动。'}</p></div> : changes.files.length === 0 ? <div className="panel-empty"><Check size={28} /><strong>工作区很整洁</strong><p>当前没有未提交的改动。</p></div> : changeGroups(changes.files).filter(group=>group.files.length).map(group=><section className="change-group" key={group.id}><h4>{group.title}<span>{group.files.length}</span></h4>{group.files.map((file:Changes['files'][number])=><button className="changed-file" key={file.path} onClick={()=>void openPreview(file.path,true,group.id as 'working'|'staged')} title={file.path}><FilePlus2 size={14}/><span>{file.path}</span><b>{file.status==='??'?'U':group.id==='staged'?file.status[0]:file.status[1]}</b></button>)}</section>)}</div><div className="inspector-footer"><span className="local-icon"><Layers size={17} /></span><div><strong>在你的电脑上工作</strong><p>会话、文件与工具由本机 Pi 管理</p></div></div></aside>}
    {settings && <Modal title="设置与连接" onClose={() => setSettings(false)}><div className="modal-body settings-body"><div className="settings-intro"><PiMark /><div><h3>Pi Desktop <span>{appVersion}</span></h3><p>为本地 Pi 打开一个更顺手的窗口。</p></div></div><label className="field-label">Pi 可执行文件</label><div className="setting-path"><code>{preferences.executable || '未设置'}</code><button className="secondary-button" disabled={locked} onClick={() => { void window.pi.chooseExecutable().then(value => { if (value) setPreferences(value); }).catch(showError); }}>选择文件</button></div><label className="field-label">Pi 配置目录</label><div className="setting-path"><code>{agentDirectory}</code><button className="secondary-button" onClick={() => void window.pi.revealConfig().catch(showError)}>打开目录</button></div><p className="setting-help">模型、登录凭据、MCP 和扩展沿用 Pi 的配置。模型与思考强度可在输入框下方切换。</p><label className="trust-option"><input type="checkbox" checked={trust} onChange={e => setTrust(e.target.checked)} /><span>本次连接加载当前项目的配置与扩展<small>默认遵循 Pi 已保存的信任设置。勾选后以 --approve 重新连接。</small></span></label><div className="settings-actions"><button className="primary-button" disabled={locked} onClick={() => { setSettings(false); void connect({ cwd, sessionPath: state.sessionFile, trust }); }}>重新连接 Pi</button><button className="secondary-button" disabled={locked} onClick={() => { setSettings(false); void chooseWorkspace(); }}>切换工作区</button></div><div className="settings-shortcuts"><span><kbd>Ctrl N</kbd> 新会话</span><span><kbd>Ctrl O</kbd> 打开文件夹</span><span><kbd>Esc</kbd> 停止任务</span><span><kbd>Ctrl ,</kbd> 设置</span></div><details className="diagnostics"><summary>连接诊断</summary><pre>{JSON.stringify({ ...diagnostics, stderr: cleanAnsi(diagnostics.stderr || '') }, null, 2)}</pre></details></div></Modal>}
    {preview&&<FilePreview preview={preview} review={review} line={previewLine} onError={showError} onClose={()=>{setPreview(null);setReview(null);}} onReference={(path,line)=>{if(references.length>=8&&!references.includes(path)){showError('一次最多引用 8 个文件');return;}setDraft(text=>`${text}${text?'\n':''}请查看文件：${path}:${line}`);setReferences(items=>[...new Set([...items,path])]);setPreview(null);editor.current?.focus();}}/>}
    {mcpOpen&&<McpPanel onClose={()=>setMcpOpen(false)} onError={showError}/>}
    {workspacePanel==='context'&&<ContextPanel key={snapshot?.generation} onClose={()=>setWorkspacePanel(null)} onChanged={()=>void refreshSnapshot()}/>}
    {workspacePanel==='agents'&&<AgentsPanel models={snapshot?.models||[]} ready={ready} cwd={cwd} mainBusy={locked} onClose={()=>setWorkspacePanel(null)} onReference={text=>{setDraft(current=>[current,text].filter(Boolean).join('\n\n'));setWorkspacePanel(null);editor.current?.focus();}} onOpenParent={path=>{setWorkspacePanel(null);void connect({sessionPath:path});}}/>}
    {conflict&&<Modal title="会话保护" onClose={()=>setConflict(null)}><div className="modal-body"><p className="dialog-message">{conflict.reason}</p><code className="conflict-path">{conflict.path}</code><p className="setting-help">复制会保留已保存的历史，并在新的会话文件中继续。</p><div className="modal-actions"><button className="secondary-button" onClick={()=>setConflict(null)}>取消</button><button className="primary-button" onClick={()=>void connect({sessionPath:conflict.path,fork:true,preserveDraft:true})}>复制为新会话</button></div></div></Modal>}
    {renameValue !== null && <Modal title="重命名会话" onClose={() => setRenameValue(null)}><form className="modal-body" onSubmit={e => { e.preventDefault(); if (renameValue.trim()) { void change('set_session_name', { name: renameValue.trim() }); setRenameValue(null); } }}><input className="dialog-input" autoFocus aria-label="会话名称" value={renameValue} onChange={e => setRenameValue(e.target.value)} /><div className="modal-actions"><button className="primary-button" disabled={!renameValue.trim()} type="submit">保存名称</button></div></form></Modal>}
    {dialogs[0] && <ExtensionDialog key={dialogs[0].id} request={dialogs[0]} onError={showError} respond={async response => { await window.pi.respond(response); setDialogs(ds => ds.filter(d => d.id !== response.id)); }} />}
  </div>;
}
