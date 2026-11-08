import { useEffect, useRef, useState, isValidElement, type ReactNode } from 'react';
import { toolCardsDefaultOpen } from './preferences.mjs';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronRight, Copy, FileCode2, Folder, LoaderCircle, Terminal, X, CircleAlert, Brain, CheckCheck } from './icons';
import type { FileEntry, Wire } from './types';
import { textContent } from './transcript.mjs';
import { CodeBlock } from './ReviewPanel';
import { parseLocalLink } from './workflows.mjs';

export function PiMark({ small = false }: { small?: boolean }) { return <span className={`pi-mark ${small ? 'small' : ''}`} aria-hidden="true">π</span>; }
export function IconButton({ label, children, onClick, disabled, className = '' }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
}
export function Modal({ title, children, onClose, wide = false, className = '' }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string }) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const modal = document.querySelector('[role="dialog"]');
        const targets = Array.from(modal?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href]') || []).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
        if (!targets?.length) return;
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && (document.activeElement === first || !modal?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !modal?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    const timer = setTimeout(() => document.querySelector<HTMLElement>('[role="dialog"] input, [role="dialog"] textarea, [role="dialog"] button')?.focus(), 20);
    return () => { document.removeEventListener('keydown', key, true); clearTimeout(timer); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><IconButton label="关闭弹窗" onClick={onClose}><X size={18} /></IconButton></header>{children}</section></div>;
}
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="copy-button" title="复制" onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }); }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制'}</button>;
}
export function RichText({ text, allowFileLinks = true }: { text: string; allowFileLinks?: boolean }) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => !allowFileLinks && href && !/^https?:\/\//.test(href) ? <code title={href}>{children}</code> : <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:\/\//.test(href)) void window.pi.openLink(href); else { const local=parseLocalLink(href); if(local) window.dispatchEvent(new CustomEvent('pi:open-file',{detail:local})); } }} title={href}>{children}</a>,
    img: ({ alt }) => <span className="image-placeholder">[图片链接：{alt || '图片'}]</span>,
    pre: ({ children }) => { const child=Array.isArray(children)?children[0]:children; const props=isValidElement<{children?:ReactNode;className?:string}>(child)?child.props:{}; return <CodeBlock text={String(props.children||'')} language={props.className?.replace('language-','')}/>; },
  }}>{text}</Markdown></div>;
}
export function ToolCard({ call, tool }: { call: Wire; tool?: Wire }) {
  const card = useRef<HTMLDetailsElement>(null);
  // 只在挂载时设置一次默认展开状态：受控 open 会与浏览器自身的 toggle 打架（挂载时的 toggle 会把卡片关掉）
  useEffect(() => { const node = card.current; if (node) node.open = toolCardsDefaultOpen(); }, []);
  const args = tool?.args || call.arguments || {};
  const target = args.path || args.command || args.pattern || args.query || '';
  const output = textContent(tool?.result?.content);
  const done = tool?.status === 'done', error = tool?.status === 'error';
  return <details className={`tool-card ${error ? 'tool-error' : ''}`} ref={card}><summary><span className="tool-icon">{error ? <CircleAlert size={15} /> : done ? <CheckCheck size={15} /> : tool?.status === 'running' ? <LoaderCircle size={15} className="spin" /> : <Terminal size={15} />}</span><span className="tool-name">{call.name || tool?.name}</span><span className="tool-target">{String(target).slice(0, 100)}</span><span className="tool-duration">{tool?.durationMs !== undefined ? `${(tool.durationMs / 1000).toFixed(1)}s` : ''}</span><ChevronRight className="disclosure" size={14} /></summary><div className="tool-body"><label>参数</label><pre>{JSON.stringify(args, null, 2)}</pre>{output && <><label>输出</label><pre>{output.slice(0, 40000)}{output.length > 40000 ? '\n…界面截取前 40,000 字符，完整结果已保存在会话中。' : ''}</pre></>}{!output && <p className="muted">{tool?.status === 'running' ? '正在执行…' : done ? '执行完成' : '等待执行结果'}</p>}</div></details>;
}
export function Message({ message, tools, agentName = 'Pi', allowFileLinks = true }: { message: Wire; tools: Record<string, Wire>; agentName?: string; allowFileLinks?: boolean }) {
  if (message.role === 'system' || message.role === 'toolResult' || message.display === false) return null;
  const user = message.role === 'user';
  if (message.role === 'compactionSummary' || message.role === 'branchSummary') return <details className="context-summary"><summary><Brain size={14} />{message.role === 'compactionSummary' ? '上下文已压缩 · 查看摘要' : '分支摘要'}</summary><RichText text={message.summary || ''} /></details>;
  if (message.role === 'bashExecution') return <ToolCard call={{ name: 'shell', arguments: { command: message.command } }} tool={{ status: message.exitCode ? 'error' : 'done', result: { content: [{ type: 'text', text: message.output }] } }} />;
  const blocks: Wire[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
  if (!blocks.length && !message.errorMessage) return null;
  return <article className={`message ${user ? 'user' : 'assistant'}`}>
    {!user && <div className="message-heading"><PiMark small /><span>{message.role === 'assistant' ? agentName : message.customType || message.role}</span>{message.model && <span className="message-model">{message.model}</span>}</div>}
    <div className="message-content">{blocks.map((block, index) => {
      if (!block) return null;
      if (block.type === 'text') return user ? <div className="user-text" key={index}>{block.text}</div> : <RichText key={index} text={block.text} allowFileLinks={allowFileLinks} />;
      if (block.type === 'thinking' && block.thinking) return <details className="thinking" key={index}><summary><Brain size={14} />思考过程<ChevronRight size={13} className="disclosure" /></summary><div>{block.thinking}</div></details>;
      if (block.type === 'toolCall') return <ToolCard key={block.id || index} call={block} tool={tools[block.id]} />;
      if (block.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(block.mimeType)) return <img className="message-image" key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="会话附件" />;
      return null;
    })}{message.errorMessage && <div className="inline-error"><CircleAlert size={16} /><span>{message.errorMessage}</span></div>}{message.stopReason === 'aborted' && <span className="message-note">已停止</span>}</div>
    {!user && textContent(message.content) && <div className="message-actions"><CopyButton text={textContent(message.content)} /></div>}
  </article>;
}
export function FileTree({ entries, onOpen, onError, depth = 0 }: { entries: FileEntry[]; onOpen: (path: string) => void; onError: (error: unknown) => void; depth?: number }) {
  return <>{entries.map(entry => <FileRow key={entry.path} entry={entry} onOpen={onOpen} onError={onError} depth={depth} />)}</>;
}
function FileRow({ entry, onOpen, onError, depth }: { entry: FileEntry; onOpen: (path: string) => void; onError: (error: unknown) => void; depth: number }) {
  const [expanded, setExpanded] = useState(false), [children, setChildren] = useState<FileEntry[]>([]), [loading, setLoading] = useState(false);
  const toggle = async () => {
    if (!entry.directory) return onOpen(entry.path);
    if (expanded) return setExpanded(false);
    setLoading(true);
    try { setChildren(await window.pi.files(entry.path)); setExpanded(true); } catch (error) { onError(error); } finally { setLoading(false); }
  };
  return <><button className="file-row" style={{ paddingLeft: 14 + depth * 14 }} onClick={() => void toggle()} title={entry.path}><ChevronRight size={12} className={`${entry.directory ? '' : 'invisible'} ${expanded ? 'rotated' : ''}`} />{loading ? <LoaderCircle size={15} className="spin" /> : entry.directory ? <Folder size={15} /> : <FileCode2 size={15} />}<span>{entry.name}</span></button>{expanded && <FileTree entries={children} onOpen={onOpen} onError={onError} depth={depth + 1} />}</>;
}
export function ExtensionDialog({ request, respond, onError }: { request: Wire; respond: (data: Wire) => Promise<void>; onError: (error: unknown) => void }) {
  const [value, setValue] = useState(request.prefill || ''), [sending, setSending] = useState(false);
  const send = async (data: Wire) => { setSending(true); try { await respond({ id: request.id, ...data }); } catch (error) { onError(error); } finally { setSending(false); } };
  return <Modal title={request.title || 'Pi 需要你的输入'} onClose={() => void send({ cancelled: true })}><div className="modal-body"><div className="eyebrow">来自 Pi 扩展</div>{request.message && <p className="dialog-message">{request.message}</p>}{request.method === 'select' ? <div className="dialog-options">{(request.options || []).map((option: string) => <button className="secondary-button" disabled={sending} key={option} onClick={() => void send({ value: option })}>{option}</button>)}</div> : request.method !== 'confirm' ? <textarea className="dialog-input" autoFocus rows={request.method === 'editor' ? 10 : 3} placeholder={request.placeholder} value={value} onChange={e => setValue(e.target.value)} /> : null}<div className="modal-actions"><button className="secondary-button" disabled={sending} onClick={() => void send({ cancelled: true })}>取消</button>{request.method !== 'select' && <button className="primary-button" disabled={sending} onClick={() => void send(request.method === 'confirm' ? { confirmed: true } : { value })}>{request.method === 'confirm' ? '确认' : '提交'}</button>}</div></div></Modal>;
}
