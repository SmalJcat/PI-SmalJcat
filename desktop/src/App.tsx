import { ComposerMetrics, usePiResponseSpeed } from './ComposerMetrics';
import { Sidebar } from './Sidebar';
import { MessageEditor } from './MessageEditor';
import { PermissionControl, ContextControl, PiPermissionDialog, usePiPermissions, usePiContext } from './ComposerStatus';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowDown, ArrowUpRight, Brain, Check, ChevronDown, ChevronRight, CircleAlert, Code2, FilePlus2, Folder, FolderOpen, GitBranch, Layers, LoaderCircle, Maximize2, MessageSquare, Minus, MoreHorizontal, PanelLeftClose, PanelRight, Paperclip, Plus, RefreshCw, Search, Settings2, Sparkles, Square, Terminal, X, Download, Plug, ShieldAlert } from './icons';
import type { Attachment, Changes, FileEntry, Preferences, Preview, Session, Snapshot, Wire } from './types';
import { emptyTranscript, loadTranscript, reduceTranscript } from './transcript.mjs';
import { ExtensionDialog, FileTree, IconButton, Message, Modal, PiMark } from './components';
import { lazy, Suspense } from 'react';
// 面板按需加载见下方 lazy 声明

// 按需加载：这些面板只在对应入口打开时才需要，放进各自的 chunk，
// 首屏不必解析它们（设置面板还连带了 5 个子面板）。
// 注意：原先这里还导入了 UpdatePanel / ExtensionsPanel / McpToolsPanel /
// WidgetHostPanel / IndexPanel，它们已经搬进 SettingsDialog，属于死导入，一并删除。
const TerminalPanel = lazy(() => import('./TerminalPanel').then(module => ({ default: module.TerminalPanel })));
const AntigravityWorkspace = lazy(() => import('./AntigravityWorkspace').then(module => ({ default: module.AntigravityWorkspace })));
const SettingsDialog = lazy(() => import('./SettingsDialog').then(module => ({ default: module.SettingsDialog })));
// 注：ReviewPanel 同时被 components.tsx 静态引用（CodeBlock），动态导入无法把它移出主包，
// 所以这两个保持静态导入，不写"看起来按需、实际仍在主包"的假懒加载。
import { FilePreview, McpPanel } from './ReviewPanel';
const ContextPanel = lazy(() => import('./WorkspacePanels').then(module => ({ default: module.ContextPanel })));
const AgentsPanel = lazy(() => import('./WorkspacePanels').then(module => ({ default: module.AgentsPanel })));

// 统一套一层 Suspense：加载中有明确提示，而不是空白或直接报错。
// 这里刻意不写泛型：React.lazy 的 LazyExoticComponent 与 ComponentType 之间没有干净的公共类型，
// 强行标注会把各面板自己的 props 类型擦掉并引发隐式 any；面板自身仍然是有类型的。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lazyPanel = (Component: any, label: string) => (props: any) => (
  <Suspense fallback={<p className="panel-help">{label}</p>}>
    <Component {...props} />
  </Suspense>
);
const LazyContextPanel = lazyPanel(ContextPanel, '正在加载上下文面板…');
const LazyAgentsPanel = lazyPanel(AgentsPanel, '正在加载子代理面板…');
const LazyTerminalPanel = lazyPanel(TerminalPanel, '正在加载终端…');
import { changeGroups } from './workflows.mjs';
import { useComposerCompletions } from './ComposerCompletions';
import { ComposerModelControl } from './ComposerModelControl';
import { Computer, Zap } from './icons';
import './styles.css';
import './workflows.css';
import './cyberpunk.css';
import './chatgpt-theme.css';
import './typography.css';
import './layout.css';
import './composer.css';
import './sidebar.css';
import { PRESETS, applyStoredPreset, changePreset } from './ui-theme.mjs';
import { applyStoredPreferences, updatePreference } from './preferences.mjs';
import { assignBinding, matchBinding, readBindings, resetBindings, writeBindings } from './shortcuts.mjs';

// 风格在模块加载时就应用，避免首屏闪一下旧主题。
const initialPreset = applyStoredPreset();
// 前端计时起点：模块开始执行（用于和 Rust 侧的阶段时间对齐）
const appStartedAt = typeof performance === 'undefined' ? 0 : performance.now();
// 界面偏好（字号/行高/字体/圆角/列宽/动效等）在模块加载时下发到根元素，避免首屏跳动。
const initialPreferences = applyStoredPreferences();

const basename = (value: string) => value?.split(/[\\/]/).filter(Boolean).pop() || '工作区';
const samePath = (a?: string, b?: string) => a?.replace(/\\/g, '/').toLowerCase() === b?.replace(/\\/g, '/').toLowerCase();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
const cleanAnsi = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const draftKey = (cwd: string, state: Wire) => `pi-draft:${cwd}:${state.sessionId || 'new'}`;
const readDraft = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };

export default function App() {
  const [preferences, setPreferences] = useState<Preferences>({ executable: '', lastWorkspace: '' });
  const [agentDirectory, setAgentDirectory] = useState('');
  const [appVersion, setAppVersion] = useState('…');
  const [uiPreset, setUiPreset] = useState(initialPreset);
  const [uiPreferences, setUiPreferences] = useState(initialPreferences);
  const [shortcuts, setShortcuts] = useState(() => readBindings(localStorage));
  const rebindShortcut = (actionId: string, combo: string) => {
    const result = assignBinding(shortcuts, actionId, combo);
    if (!result.ok) return result.reason;
    writeBindings(localStorage, result.bindings);
    setShortcuts(result.bindings);
    return '';
  };
  const restoreShortcuts = () => setShortcuts(resetBindings(localStorage));
  const changePreference = (key: string, value: string | boolean) => setUiPreferences(updatePreference(document.documentElement, localStorage, key, value));
  const [acpActive, setAcpActive] = useState(false), [acpOpened, setAcpOpened] = useState(false);
  const [acpContextSignal,setAcpContextSignal]=useState(0);
  const [acpStatus, setAcpStatus] = useState<Wire>({});
  const [workspacePanel, setWorkspacePanel] = useState<'context' | 'agents' | 'terminal' | null>(null);
  const [mcpOpen,setMcpOpen]=useState(false);
  const [recovery,setRecovery]=useState<Wire|null>(null);
  const [conflict,setConflict]=useState<{path:string;reason:string}|null>(null);
  const [references,setReferences]=useState<string[]>([]);
  const [review,setReview]=useState<Wire|null>(null);
  const [previewLine,setPreviewLine]=useState(1);
  const [cwd, setCwd] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [messageEdit,setMessageEdit] = useState<Wire|null>(null);
  const [transcript, setTranscript] = useState<Wire>(emptyTranscript());
  const [connection, setConnection] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [search, setSearch] = useState('');
  // 会话正文检索：标题匹配走本地过滤，正文匹配走 FTS 索引（防抖 220ms）
  const [contentHits, setContentHits] = useState<Wire[]>([]);
  const [contentMode, setContentMode] = useState('');
  const [contentBusy, setContentBusy] = useState(false);
  const [contentNote, setContentNote] = useState('');
  const [contentIndexedAt, setContentIndexedAt] = useState(0);
  const [hitSince, setHitSince] = useState(0);
  const [hitScoped, setHitScoped] = useState(false);
  // 命中定位：打开会话后按关键词在已渲染的消息里找，滚动过去并短暂高亮
  const [hitTerms, setHitTerms] = useState<string[]>([]);
  const [locateRetry, setLocateRetry] = useState(0);
  const [locateNote, setLocateNote] = useState('');
  // 命中导航：会话内所有命中 + 当前位置
  const [locateIndex, setLocateIndex] = useState(0);
  const [locateCount, setLocateCount] = useState(0);
  const expandedForLocate = useRef(false);
  const openHit = (hit: Wire) => {
    setLocateNote('');
    setLocateRetry(0);
    setLocateIndex(0);
    setLocateCount(0);
    expandedForLocate.current = false;
    setHitTerms(search.trim().split(/\s+/).filter(Boolean));
    void connect({ sessionPath: hit.path });
  };
  // 收集当前会话里所有命中的消息节点（不缓存 DOM，导航时重算，节点很少）
  const collectMatches = () => {
    const container = scroll.current;
    if (!container || !hitTerms.length) return [] as HTMLElement[];
    const lower = hitTerms.map(term => term.toLowerCase());
    return Array.from(container.querySelectorAll('.message')).filter(element => {
      const text = (element.textContent || '').toLowerCase();
      return lower.every(term => text.includes(term));
    }) as HTMLElement[];
  };
  const revealMatch = (elements: HTMLElement[], index: number) => {
    const node = elements[index];
    if (!node) return;
    // 关掉"跟随最新"，否则自动滚到底会把定位冲掉
    setFollowing(false);
    node.scrollIntoView({ block: 'center' });
    node.classList.add('hit-flash');
    setTimeout(() => node.classList.remove('hit-flash'), 2600);
  };
  const stepMatch = (delta: number) => {
    const elements = collectMatches();
    if (!elements.length) return;
    const next = (locateIndex + delta + elements.length) % elements.length;
    setLocateIndex(next);
    setLocateCount(elements.length);
    revealMatch(elements, next);
  };
  useEffect(() => {
    const query = search.trim();
    if (query.length < 2) {
      setContentHits([]);
      setContentMode('');
      setContentBusy(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setContentBusy(true);
      void window.pi
        .sessionSearch({ query, limit: 8, sinceDays: hitSince, workspace: hitScoped ? cwd : '' })
        .then(value => {
          if (cancelled) return;
          setContentHits(value.items || []);
          setContentMode(value.mode || '');
          // 首次检索会顺带建索引，把结果说清楚，避免"搜不到但其实没建索引"
          setContentIndexedAt(Number(value.stats?.lastSyncAtMs) || 0);
          setContentNote(value.firstSync
            ? `检索前已增量同步：${value.firstSync.files} 个会话（新索引 ${value.firstSync.indexed}，跳过 ${value.firstSync.skipped}，失败 ${value.firstSync.failed}）`
            : '');
        })
        .catch(error => {
          if (cancelled) return;
          setContentHits([]);
          setContentNote(`检索失败：${errorText(error)}`);
        })
        .finally(() => { if (!cancelled) setContentBusy(false); });
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search, hitSince, hitScoped, cwd]);
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
  const [rightPanel, setRightPanel] = useState(() => readDraft('pi-inspector-open') !== 'false');
  const [acpRightPanel, setAcpRightPanel] = useState(false);
  useEffect(() => { try { localStorage.setItem('pi-inspector-open', String(rightPanel)); } catch {} }, [rightPanel]);
  const [leftPanel, setLeftPanel] = useState(true);
  const [panelTab, setPanelTab] = useState('files');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [changes, setChanges] = useState<Changes>({ available: false, branch: '', files: [] });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!more) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest('.menu-anchor')) setMore(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setMore(false); }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [more]);
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
  const piPermissions=usePiPermissions(showError);
  const piContext=usePiContext(ready,!acpActive,state.model,snapshot?.generation,snapshot?.stats?.contextUsage);
  const responseSpeed=usePiResponseSpeed(snapshot?.generation,state.sessionId,`${state.model?.provider}/${state.model?.id}`,ready);

  const completion = useComposerCompletions({
    draft, setDraft, ready, scope: `${cwd}:${snapshot?.generation ?? 0}`, commands: (snapshot?.commands || []).filter((command:Wire)=>!['desktop-context','desktop-permissions'].includes(command.name)), editor,
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
    setAcpActive(false);
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
      if (preserveDraft && options.sessionPath) {
        setMessageEdit(current => current && samePath(current.sessionPath, options.sessionPath)
          ? {...current, sessionPath:next.state.sessionFile, sessionId:next.state.sessionId, preparedSessionId:current.preparedSessionId ? next.state.sessionId : undefined}
          : current);
      }
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
    if (event.type === 'agent_settled') { setStatus(event.aborted ? '已停止' : ''); void refreshSnapshot(); void refreshSessions(cwd); void refreshFiles(); void window.pi.sessionIndexSync().catch(() => {}); }
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
  // 独立审阅窗口把文件引用发回主窗口（路线图 P2.2）：复用输入框既有的引用格式。
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ path: string; line?: number }>('review://reference', event => {
        const path = event.payload?.path;
        if (!path) return;
        const line = Number(event.payload?.line) > 0 ? Number(event.payload?.line) : 1;
        setDraft(text => `${text}${text ? '\n' : ''}请查看文件：${path}:${line}`);
        setReferences(items => (items.includes(path) || items.length >= 8 ? items : [...items, path]));
        editor.current?.focus();
      }))
      .then(unlisten => { dispose = unlisten; })
      .catch(() => {});
    return () => { if (dispose) dispose(); };
  }, []);
  // 定位命中位置：等消息渲染出来再找（会话历史是异步到达的，所以带有限次重试）
  useEffect(() => {
    if (!hitTerms.length) return;
    const container = scroll.current;
    const lower = hitTerms.map(term => term.toLowerCase());
    const node = container
      ? (Array.from(container.querySelectorAll('.message')).find(element => {
          const text = (element.textContent || '').toLowerCase();
          return lower.every(term => text.includes(term));
        }) as HTMLElement | undefined)
      : undefined;
    if (!node) {
      // 命中可能在更早的消息里：先用"显示更早的消息"把完整历史放出来，再重试
      if (!showAllMessages && transcript.messages.length > 100 && !expandedForLocate.current) {
        expandedForLocate.current = true;
        setShowAllMessages(true);
        return;
      }
      // 会话历史是异步到达的：给足重试预算（约 5 秒），避免"还没渲染就判定找不到"
      if (locateRetry < 8) {
        const timer = setTimeout(() => setLocateRetry(value => value + 1), 600);
        return () => clearTimeout(timer);
      }
      setLocateNote('命中的内容不在当前会话里（可能来自其它工作区的会话，或已被清理）');
      setHitTerms([]);
      setLocateCount(0);
      return;
    }
    const elements = collectMatches();
    const index = Math.max(0, elements.indexOf(node));
    setLocateIndex(index);
    setLocateCount(elements.length);
    revealMatch(elements, index);
    setLocateNote('');
    const timer = setTimeout(() => node.classList.remove('hit-flash'), 2600);
    return () => clearTimeout(timer);
  }, [hitTerms, locateRetry, transcript.messages.length, showAllMessages]);

  // 前端错误也留一份本地报告（不改变控制台行为，只多一份可诊断的副本）
  useEffect(() => {
    const reportError = (message: string, detail: string) => {
      void window.pi.crashReport({ message, detail }).catch(() => {});
    };
    const onError = (event: ErrorEvent) => reportError(event.message || '前端脚本错误', String(event.error?.stack || ''));
    const onRejection = (event: PromiseRejectionEvent) => reportError('未处理的 Promise 拒绝', String((event.reason && event.reason.stack) || event.reason || ''));
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // 首次渲染后上报一次，让 Rust 侧能给出"冷启动到可交互"的总时间
  const reportedReady = useRef(false);
  useEffect(() => {
    if (reportedReady.current) return;
    reportedReady.current = true;
    const renderMs = Math.round((typeof performance === 'undefined' ? 0 : performance.now()) - appStartedAt);
    void window.pi.startupReady({ renderMs }).then(value => {
      const total = value?.startup?.totalMs;
      if (typeof total === 'number') console.info('启动耗时', total + 'ms（前端渲染 ' + renderMs + 'ms）');
    }).catch(() => {});
  }, []);
  // 索引新鲜度展示：搜索本身会在陈旧时自动增量同步，这里把时间说清楚
  const describeAge = (at: number) => {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 10) return '刚刚';
    if (seconds < 60) return seconds + ' 秒前';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + ' 分钟前';
    return Math.round(minutes / 60) + ' 小时前';
  };
  // 任务完成通知：窗口不在前台时才打扰；是否真的发送由 Rust 侧偏好决定。
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running && !document.hasFocus()) {
      void window.pi.systemNotify({ title: 'Pi Desktop', body: '任务已完成' }).catch(() => {});
    }
    wasRunning.current = running;
  }, [running]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || document.querySelector('[role="dialog"]')) return;
      const action = matchBinding(shortcuts, e);
      if (acpActive && !['settings', 'toggleSidebar', 'toggleInspector'].includes(action || '')) return;
      if (!action) return;
      if (action === 'newSession' && !locked) { e.preventDefault(); void connect({ cwd }); return; }
      if (action === 'openFolder' && !locked) { e.preventDefault(); void chooseWorkspace(); return; }
      if (action === 'settings') { e.preventDefault(); setSettings(true); return; }
      if (action === 'stopTask' && running) { e.preventDefault(); void stop(); return; }
      if (action === 'searchSessions') {
        e.preventDefault();
        setLeftPanel(true);
        requestAnimationFrame(() => {
          const box = document.querySelector<HTMLInputElement>('.search-box input');
          box?.focus(); box?.select();
        });
        return;
      }
      if (action === 'toggleSidebar') { e.preventDefault(); setLeftPanel(value => !value); return; }
      if (action === 'toggleInspector') { e.preventDefault(); if (acpActive) setAcpRightPanel(value => !value); else setRightPanel(value => !value); return; }
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
  const submitMessageEdit = async (text:string, images:Wire[]) => {
    if (!messageEdit || !ready || locked) throw new Error('请等待当前任务结束后重试');
    if (images.length && !state.model?.input?.includes('image')) throw new Error('当前模型不支持图片，请移除图片或切换模型');
    const message = text.trim() ? text : images.length ? '请查看附件。' : '';
    if (!message || new TextEncoder().encode(message).length > 2 * 1024 * 1024) throw new Error('消息为空或过长。');
    setActionPending(true); setNotice(null);
    try {
      let sessionId = messageEdit.preparedSessionId;
      if (!sessionId) {
        const result = await window.pi.prepareMessageEdit({sessionId:messageEdit.sessionId,entryId:messageEdit.message._entryId});
        if (result.cancelled) return false;
        const next = result.snapshot;
        if (!next) throw new Error('Pi 未返回编辑分支');
        generation.current = next.generation;
        setSnapshot(next);setTranscript(loadTranscript(next.messages,next.state.isStreaming||next.state.isCompacting));
        setMessageEdit(previous=>previous?{...previous,preparedSessionId:next.state.sessionId,sessionPath:next.state.sessionFile}:previous);
        sessionId = next.state.sessionId;
        void refreshSessions(next.cwd);
      }
      await window.pi.command('prompt',{message,...(images.length?{images}:{}),expectedSessionId:sessionId});
      setMessageEdit(null);setFollowing(true);void refreshSessions(cwd);
      return true;
    } finally {setActionPending(false);}
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
  const change = async (type: string, data?: Wire, propagateError = false) => {
    setActionPending(true);
    try { await window.pi.command(type, data); await refreshSnapshot(); if (type === 'set_session_name') void refreshSessions(cwd); }
    catch (error) { if (propagateError) throw error; showError(error); } finally { setActionPending(false); }
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
  const visibleMessages = transcript.messages.filter((m: Wire) => m.role !== 'system' && m.role !== 'toolResult' && m.display !== false);
  const displayedMessages = showAllMessages ? visibleMessages : visibleMessages.slice(-100);
  const pendingCount = queue.steering.length + queue.followUp.length;

  const inspectorOpen = acpActive ? acpRightPanel : rightPanel;
  return <div className={`app-shell ${leftPanel ? '' : 'no-sidebar'} ${inspectorOpen ? '' : 'no-inspector'}`}>
    <div className="titlebar" data-tauri-drag-region><div className="app-brand"><PiMark small /><span>Pi Desktop</span><span className="preview-label">LOCAL</span></div><div className="titlebar-center">你的想法，本地的工作空间</div><div className="window-controls"><button aria-label="最小化" onClick={() => void window.pi.window('minimize')}><Minus size={16} /></button><button aria-label="最大化" onClick={() => void window.pi.window('maximize')}><Maximize2 size={13} /></button><button aria-label="关闭窗口" className="close-window" onClick={() => void window.pi.window('close')}><X size={17} /></button></div></div>
    <Sidebar hidden={!leftPanel} onError={showError} cwd={cwd} recentWorkspaces={preferences.recentWorkspaces || []} sessions={sessions} activeId={acpActive ? undefined : state.sessionId} locked={locked} search={search} onSearch={setSearch} onConnect={options => void connect(options)} onChooseWorkspace={() => void chooseWorkspace()}
      home={<button aria-label="Pi 会话" title="Pi 会话" aria-pressed={!acpActive} onClick={() => setAcpActive(false)}><MessageSquare size={19}/></button>}
      newChat={<button className="new-chat" onClick={() => void connect({ cwd })} disabled={locked}><Plus size={17}/><span>{acpActive ? '新建 Pi 会话' : '新会话'}</span>{!acpActive && <kbd>Ctrl N</kbd>}</button>}
      navigation={<div className="workspace-tools">{typeof window.pi.antigravity === 'function' && <button aria-label="Antigravity 会话" title="Antigravity 会话" aria-pressed={acpActive} onClick={() => {setAcpOpened(true);setAcpActive(value => !value);}}><Zap size={19}/>{(acpStatus.busy || acpStatus.permissions > 0) && <span className="acp-nav-status">{acpStatus.permissions > 0 ? '待确认' : '运行中'}</span>}</button>}<button aria-label={acpActive ? 'Antigravity 上下文信息' : '上下文管理'} title="上下文" disabled={!acpActive && !ready} onClick={() => {if(acpActive)setAcpContextSignal(value => value + 1);else setWorkspacePanel('context');}}><Brain size={19}/></button><button aria-label="工作区命令" title="工作区命令" disabled={!ready} onClick={() => {setAcpActive(false);setWorkspacePanel('terminal');}}><Terminal size={19}/></button><button aria-label="子代理工作台" title="子代理工作台" onClick={() => {setAcpActive(false);setWorkspacePanel('agents');}}><Layers size={19}/></button></div>}
      footer={<div className="sidebar-footer"><div className={`connection-pill ${connection}`} role="status" aria-label={connection === 'ready' ? 'Pi 已连接' : connection === 'connecting' ? '正在连接 Pi…' : 'Pi 未连接'} title={connection === 'ready' ? 'Pi 已连接' : connection === 'connecting' ? '正在连接 Pi…' : 'Pi 未连接'}><span className="status-dot"/></div><button aria-label="MCP 连接" title="MCP 连接" onClick={() => setMcpOpen(true)} disabled={!ready || locked}><Plug size={19}/></button><button aria-label="设置与连接" title="设置与连接 · Ctrl ," onClick={() => setSettings(true)}><Settings2 size={19}/></button></div>}
    >
      {search.trim().length >= 2 && (
        <div className="content-hits">
          <div className="session-label"><span>全文检索（含归档）{contentBusy ? '…' : ''}{contentIndexedAt > 0 && <span className="content-age">索引 {describeAge(contentIndexedAt)}</span>}</span><button onClick={() => {
            setContentBusy(true);
            setContentNote('');
            void window.pi.sessionIndexSync()
              .then(result => {
                const summary = result.summary || {};
                setContentNote(`已建立索引：${summary.files ?? 0} 个会话（新索引 ${summary.indexed ?? 0}，跳过 ${summary.skipped ?? 0}，失败 ${summary.failed ?? 0}）`);
                return window.pi.sessionSearch({ query: search.trim(), limit: 8, sinceDays: hitSince, workspace: hitScoped ? cwd : '' });
              })
              .then(value => { setContentHits(value.items || []); setContentMode(value.mode || ''); })
              .catch(error => setContentNote(`索引失败：${errorText(error)}`))
              .finally(() => setContentBusy(false));
          }}>刷新索引</button></div>
          <div className="hit-filters" role="group" aria-label="检索过滤">
            {([['全部', 0], ['今天', 1], ['7 天', 7], ['30 天', 30]] as [string, number][]).map(([label, days]) => (
              <button key={label} className={hitSince === days ? 'hit-filter active' : 'hit-filter'} onClick={() => setHitSince(days)}>{label}</button>
            ))}
            <button className={hitScoped ? 'hit-filter active' : 'hit-filter'} onClick={() => setHitScoped(!hitScoped)}>仅当前工作区</button>
          </div>
          {contentHits.length
            ? contentHits.map(hit => (
                <button key={hit.path} className="content-hit" disabled={locked} onClick={() => openHit(hit)} title={hit.path}>
                  <MessageSquare size={13} />
                  <span>
                    <strong>{hit.title || '未命名会话'}</strong>
                    <small>{hit.snippet}</small>
                  </span>
                </button>
              ))
            : <p className="content-empty">{contentBusy ? '正在检索…' : '正文里没有匹配的会话，可点「刷新索引」重建'}</p>}
          {contentNote && <p className="content-empty">{contentNote}</p>}
          {contentMode === 'like' && contentHits.length > 0 && <p className="content-empty">关键词少于 3 个字符，已按包含匹配（更长关键词会带相关性排序）</p>}
        </div>
      )}
    </Sidebar>
    <main className={`main-area ${acpActive ? 'backend-hidden' : ''} ${connection === 'ready' && visibleMessages.length === 0 ? 'empty-conversation' : ''}`}><header className="conversation-header"><IconButton label={leftPanel ? '收起侧栏' : '展开侧栏'} onClick={() => setLeftPanel(!leftPanel)}><PanelLeftClose size={18} /></IconButton><div className="breadcrumb"><span>{basename(cwd)}</span><ChevronRight size={13} /><strong title={title}>{title}</strong></div><div className="header-actions">{changes.available && <span className="branch-badge"><GitBranch size={13} />{changes.branch}</span>}<button className="text-button open-folder" onClick={() => void window.pi.revealWorkspace().catch(showError)}><FolderOpen size={15} />打开文件夹<ArrowUpRight size={13} /></button><IconButton label="文件与改动" onClick={() => setRightPanel(!rightPanel)} className={rightPanel ? 'selected' : ''}><PanelRight size={18} /></IconButton><div className="menu-anchor"><IconButton label="会话操作" onClick={() => setMore(!more)}><MoreHorizontal size={19} /></IconButton>{more && <div className="dropdown-menu"><button disabled={locked || !ready} onClick={() => { setMore(false); setRenameValue(title); }}><MessageSquare size={15} />重命名会话</button><button disabled={locked || !ready} onClick={() => { setMore(false); void window.pi.exportSession().then(result => { if (result) setNotice({ text: `会话已导出：${result}` }); }).catch(showError); }}><Download size={15} />导出 HTML</button><button disabled={locked || !ready} onClick={() => { setMore(false); void change('compact'); }}><Layers size={15} />压缩上下文</button></div>}</div></div></header>
      <div className="conversation-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}>
        {connection === 'connecting' && !snapshot ? <div className="panel-empty"><LoaderCircle size={20} className="spin" /></div> : visibleMessages.length === 0 ? <div className="welcome"><h1>今天，一起做点什么？</h1><div className="suggestions">{[
          { icon: <Code2 size={20} />, title: '了解这个项目', desc: '梳理结构，找到开始的地方', prompt: '请先只读查看当前项目，介绍它的用途、主要目录和推荐的运行方式。' },
          { icon: <Sparkles size={20} />, title: '实现一个想法', desc: '把想法变成能运行的代码', prompt: '我想在这个项目里实现一个功能：' },
          { icon: <GitBranch size={20} />, title: '检查代码改动', desc: '找出问题，让改动更可靠', prompt: '请只读审查当前工作区的 Git 改动，重点指出真实缺陷、潜在回归和缺少的验证。' },
        ].map(suggestion => <button key={suggestion.title} className="suggestion-card" onClick={() => { setDraft(suggestion.prompt); editor.current?.focus(); }}><strong>{suggestion.title}<ArrowUpRight size={15} /></strong></button>)}</div></div> : <div className="transcript">{visibleMessages.length > 100 && !showAllMessages && <button className="load-earlier" onClick={() => setShowAllMessages(true)}>显示更早的 {visibleMessages.length - 100} 条消息</button>}{displayedMessages.map((message: Wire) => <Message key={message._key} message={message} tools={transcript.tools} editDisabled={locked||!ready||!message._entryId||!window.pi.prepareMessageEdit} onEdit={message=>setMessageEdit({message,sessionId:state.sessionId,sessionPath:state.sessionFile})} />)}{running && <div className="working-indicator"><span className="working-dots"><i /><i /><i /></span>{status || 'Pi 正在处理'}</div>}</div>}
      </div>
      <div className="composer-area">{recovery?.sessionPath&&<div className="recovery-banner"><ShieldAlert size={16}/><span>{recovery.interrupted?'上次任务被中断，可恢复已保存的会话。':'可继续上次保存的会话。'}</span><button disabled={locked} onClick={()=>void connect({sessionPath:recovery.sessionPath,preserveDraft:connection==='error'})}>恢复会话</button><button onClick={()=>setRecovery(null)} aria-label="忽略恢复提示"><X size={14}/></button></div>}{!following && visibleMessages.length > 0 && <button className="jump-bottom" onClick={() => setFollowing(true)}><ArrowDown size={14} />回到最新</button>}
        {hitTerms.length > 0 && (
          <div className="locate-bar" role="status">
            <span>第 {locateCount ? locateIndex + 1 : 0} / {locateCount} 处</span>
            <button onClick={() => stepMatch(-1)} disabled={!locateCount} aria-label="上一个命中">↑</button>
            <button onClick={() => stepMatch(1)} disabled={!locateCount} aria-label="下一个命中">↓</button>
            <button onClick={() => { setHitTerms([]); setLocateCount(0); setLocateNote(''); }} aria-label="关闭命中导航">×</button>
          </div>
        )}
        {locateNote && <div className="locate-note" role="status">{locateNote}</div>}
        {notice && <div role={notice.error ? 'alert' : 'status'} className={`notice ${notice.error ? 'error' : ''}`}><span>{notice.error ? <CircleAlert size={16} /> : <Check size={16} />}</span><div>{notice.text}</div><IconButton label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></IconButton></div>}
        {Object.values(widgets).some(lines => lines.length > 0) && <div className="extension-widgets">{Object.entries(widgets).map(([key, lines]) => lines.length ? <pre key={key}>{lines.join('\n')}</pre> : null)}</div>}
        {pendingCount > 0 && <div className="queue-banner"><Layers size={14} /><span>{queue.steering.length} 条补充指令 · {queue.followUp.length} 条后续消息</span><button onClick={() => { void window.pi.command('clear_queue').then((result: Wire) => { const restored = [...result.steering, ...result.followUp].join('\n\n'); setDraft(current => [current, restored].filter(Boolean).join('\n\n')); }).catch(showError); }}>取回编辑</button></div>}
        <div className="composer-context"><button className="composer-project" aria-label="切换输入工作区" title={cwd} disabled={locked} onClick={() => void chooseWorkspace()}><Folder size={15}/><span>{basename(cwd)}</span><ChevronDown size={12}/></button><span className="composer-computer"><Computer size={18}/>此计算机</span></div>
        <div className={`composer ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={e => { e.preventDefault(); setDragging(false); const paths = Array.from(e.dataTransfer.files).map(f => window.pi.pathForFile(f)).filter(Boolean); void window.pi.attachments(paths).then(addAttachments).catch(showError); }}>
          {completion.menu}
          {references.length>0&&<div className="reference-chips">{references.map(path=><span key={path}><FilePlus2 size={13}/>{path}<button aria-label={`移除引用 ${path}`} onClick={()=>setReferences(items=>items.filter(p=>p!==path))}><X size={12}/></button></span>)}<small>发送时附带文件文本</small></div>}
          {attachments.length > 0 && <div className="attachments">{attachments.map((attachment, index) => <div className="attachment" key={`${attachment.name}-${index}`}>{attachment.mimeType ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /> : <FilePlus2 size={18} />}<span>{attachment.name}<small>{Math.max(1, Math.round(attachment.size / 1024))} KB</small></span><IconButton label={`移除 ${attachment.name}`} onClick={() => setAttachments(items => items.filter((_, i) => i !== index))}><X size={13} /></IconButton></div>)}</div>}
          <textarea ref={editor} {...completion.inputProps} aria-label="消息" placeholder={dragging ? '放开以添加文件或图片' : running ? '补充要求，或安排接下来的任务…' : '随心输入'} rows={2} value={draft} onKeyDown={e => { if(e.nativeEvent.isComposing||e.keyCode===229)return;if(completion.onKeyDown(e))return; const submit = uiPreferences.enterToSend ? (e.key === 'Enter' && !e.shiftKey) : (e.key === 'Enter' && (e.ctrlKey || e.metaKey)); if (submit && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send(); } }} onPaste={e => { const images = Array.from(e.clipboardData.files).filter(file => file.type.startsWith('image/')); if (images.length) { e.preventDefault(); void pasteImages(images); } }} />
          <div className="composer-toolbar"><div className="composer-options"><IconButton label="添加附件" onClick={() => void chooseAttachments()}><Plus size={21} /></IconButton><PermissionControl scope="Pi" mode={piPermissions.policy.mode} rules={piPermissions.policy.rules} configFile={piPermissions.policy.configFile} configError={piPermissions.policy.configError} locked={locked || !!piPermissions.policy.requests.length} onChange={piPermissions.change} onError={showError}/></div>
            <div className="send-controls"><ContextControl scope="Pi" usage={piContext.usage} windowSize={state.model?.contextWindow} estimated stale={piContext.stale} compacting={piContext.compacting} busy={running} autoCompact={piContext.autoCompact} connected={ready} onSettings={()=>setWorkspacePanel('context')}/><ComposerModelControl fastMode={state.fastMode} onFastChange={enabled => change('set_fast_mode', {enabled, expectedSessionId:state.sessionId, modelKey:`${state.model?.provider}/${state.model?.id}`}, true)} models={snapshot?.models || []} model={state.model} levels={snapshot?.levels || ['off']} level={state.thinkingLevel || 'off'} ready={ready} locked={locked} onModelChange={selected => change('set_model', { provider: selected.provider, modelId: selected.id }, true)} onLevelChange={level => change('set_thinking_level', { level }, true)} onError={showError}/>{running && <select className="queue-select" aria-label="发送方式" value={queueMode} onChange={e => setQueueMode(e.target.value)}><option value="steer">补充指令</option><option value="followUp">完成后发送</option></select>}<button className={`send-button ${running ? 'stop-mode' : ''}`} aria-label={running ? '停止任务' : '发送消息'} title={running ? '停止任务 · Esc' : '发送 · Enter'} onClick={() => void (running ? stop() : send())} disabled={running ? actionPending : (!ready || submitting || actionPending || (!draft.trim() && !attachments.length))}>{running ? <Square size={14} fill="currentColor" /> : submitting ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={22} />}</button></div></div>
        </div>
        <div className="composer-footer"><span className="composer-footer-status"><span className={`status-dot ${running ? 'busy' : ''}`} />{running ? status || '处理中' : connection === 'connecting' ? '正在连接…' : ready ? '本地工作区' : '未连接'}{Object.values(statuses).filter(Boolean).slice(0, 1).map(text => <span className="extension-status" key={text} title={text}> · {text}</span>)}<ComposerMetrics scope="Pi" speed={responseSpeed} cost={{amount:piContext.cost??snapshot?.stats?.cost,currency:'USD'}} stale={!ready||piContext.stale}/></span>{connection === 'error' ? <button onClick={() => void connect({ cwd, sessionPath: state.sessionFile, preserveDraft:true })}>重新连接</button> : <span className="composer-footer-hints"><kbd>{uiPreferences.enterToSend ? 'Enter' : 'Ctrl Enter'}</kbd> 发送<span className="footer-divider">·</span><kbd>{uiPreferences.enterToSend ? 'Shift Enter' : 'Enter'}</kbd> 换行</span>}</div>
      </div>
    </main>
    {acpOpened && <Suspense fallback={acpActive ? <main className="main-area"><p className="panel-help">正在加载 Antigravity…</p></main> : null}><AntigravityWorkspace openContextSignal={acpContextSignal} active={acpActive} cwd={cwd} onBack={() => setAcpActive(false)} onStatus={setAcpStatus} leftPanel={leftPanel} onToggleLeftPanel={() => setLeftPanel(v => !v)} rightPanel={acpRightPanel} onToggleRightPanel={() => setAcpRightPanel(v => !v)}/></Suspense>}
    {inspectorOpen && <aside className="inspector"><header><div className="panel-tabs"><button className={panelTab === 'files' ? 'active' : ''} onClick={() => setPanelTab('files')}>文件</button><button className={panelTab === 'changes' ? 'active' : ''} onClick={() => setPanelTab('changes')}>改动{changes.files.length > 0 && <span>{changes.files.length}</span>}</button></div><IconButton label="在新窗口打开审阅" onClick={() => void window.pi.reviewWindowOpen({ file: preview?.path }).catch(showError)}><Maximize2 size={14} /></IconButton><IconButton label="刷新文件" disabled={!ready} onClick={() => void refreshFiles()}><RefreshCw size={14} /></IconButton></header><div className="inspector-subtitle"><Folder size={13} /><strong>{basename(cwd)}</strong><span>{panelTab === 'files' ? '工作区' : changes.branch}</span></div><div className="inspector-content">{panelTab === 'files' ? <FileTree key={`${cwd}:${fileTreeRevision}`} entries={files} onOpen={file => void openPreview(file)} onError={showError} /> : !changes.available ? <div className="panel-empty"><GitBranch size={28} /><strong>这里还没有 Git 仓库</strong><p>{changes.reason || '选择一个 Git 项目，即可查看文件改动。'}</p></div> : changes.files.length === 0 ? <div className="panel-empty"><Check size={28} /><strong>工作区很整洁</strong><p>当前没有未提交的改动。</p></div> : changeGroups(changes.files).filter(group=>group.files.length).map(group=><section className="change-group" key={group.id}><h4>{group.title}<span>{group.files.length}</span></h4>{group.files.map((file:Changes['files'][number])=><button className="changed-file" key={file.path} onClick={()=>void openPreview(file.path,true,group.id as 'working'|'staged')} title={file.path}><FilePlus2 size={14}/><span>{file.path}</span><b>{file.status==='??'?'U':group.id==='staged'?file.status[0]:file.status[1]}</b></button>)}</section>)}</div><div className="inspector-footer"><span className="local-icon"><Layers size={17} /></span><div><strong>在你的电脑上工作</strong><p>会话、文件与工具由本机 Pi 管理</p></div></div></aside>}
    {settings && <Modal wide title="设置与连接" onClose={() => setSettings(false)}><Suspense fallback={<div className="modal-body"><p className="setting-help">正在加载设置…</p></div>}><SettingsDialog appVersion={appVersion} uiPreferences={uiPreferences} onPreference={changePreference} shortcuts={shortcuts} onRebind={rebindShortcut} onRestoreShortcuts={restoreShortcuts} preferences={preferences} agentDirectory={agentDirectory} trust={trust} onTrustChange={setTrust} locked={locked} uiPreset={uiPreset} onPresetChange={value => setUiPreset(changePreset(value))} diagnostics={diagnostics} onClose={() => setSettings(false)} onError={showError} onExecutableChange={setPreferences} onReconnect={() => { setSettings(false); void connect({ cwd, sessionPath: state.sessionFile, trust }); }} onChooseWorkspace={() => { setSettings(false); void chooseWorkspace(); }} /></Suspense></Modal>}
    {preview&&<FilePreview preview={preview} review={review} line={previewLine} onError={showError} onClose={()=>{setPreview(null);setReview(null);}} onReference={(path:string,line:number)=>{if(references.length>=8&&!references.includes(path)){showError('一次最多引用 8 个文件');return;}setDraft((text:string)=>`${text}${text?'\n':''}请查看文件：${path}:${line}`);setReferences(items=>[...new Set([...items,path])]);setPreview(null);editor.current?.focus();}}/>}
    {mcpOpen&&<McpPanel onClose={()=>setMcpOpen(false)} onError={showError}/>}
    {workspacePanel==='terminal'&&<LazyTerminalPanel cwd={cwd} onClose={()=>setWorkspacePanel(null)} onError={showError}/>}
{workspacePanel==='context'&&<LazyContextPanel key={snapshot?.generation} onClose={()=>setWorkspacePanel(null)} onChanged={()=>void refreshSnapshot()}/>}
    {workspacePanel==='agents'&&<LazyAgentsPanel models={snapshot?.models||[]} ready={ready} cwd={cwd} mainBusy={locked} onClose={()=>setWorkspacePanel(null)} onReference={(text:string)=>{setDraft(current=>[current,text].filter(Boolean).join('\n\n'));setWorkspacePanel(null);editor.current?.focus();}} onOpenParent={(path:string)=>{setWorkspacePanel(null);void connect({sessionPath:path});}}/>}
    {renameValue !== null && <Modal title="重命名会话" onClose={() => setRenameValue(null)}><form className="modal-body" onSubmit={e => { e.preventDefault(); if (renameValue.trim()) { void change('set_session_name', { name: renameValue.trim() }); setRenameValue(null); } }}><input className="dialog-input" autoFocus aria-label="会话名称" value={renameValue} onChange={e => setRenameValue(e.target.value)} /><div className="modal-actions"><button className="primary-button" disabled={!renameValue.trim()} type="submit">保存名称</button></div></form></Modal>}
    {piPermissions.policy.requests[0] && !dialogs.length && !acpStatus.permissions && <PiPermissionDialog key={piPermissions.policy.requests[0].id} request={piPermissions.policy.requests[0]} onReply={piPermissions.reply} onStop={()=>piPermissions.stop(piPermissions.policy.requests[0])}/>}
    {messageEdit&&<MessageEditor key={messageEdit.message._key} message={messageEdit.message} prepared={!!messageEdit.preparedSessionId} disabled={!ready||locked} onSubmit={submitMessageEdit} onReconnect={connection==='error'?async()=>{await connect({sessionPath:messageEdit.sessionPath,preserveDraft:true});}:undefined} onClose={()=>setMessageEdit(null)}/>}
    {conflict&&<Modal title="会话保护" onClose={()=>setConflict(null)}><div className="modal-body"><p className="dialog-message">{conflict.reason}</p><code className="conflict-path">{conflict.path}</code><p className="setting-help">复制会保留已保存的历史，并在新的会话文件中继续。</p><div className="modal-actions"><button className="secondary-button" onClick={()=>setConflict(null)}>取消</button><button className="primary-button" onClick={()=>void connect({sessionPath:conflict.path,fork:true,preserveDraft:true})}>复制为新会话</button></div></div></Modal>}
    {dialogs[0] && <ExtensionDialog key={dialogs[0].id} request={dialogs[0]} onError={showError} respond={async response => { await window.pi.respond(response); setDialogs(ds => ds.filter(d => d.id !== response.id)); }} />}
  </div>;
}
