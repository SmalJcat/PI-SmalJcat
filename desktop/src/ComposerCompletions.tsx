import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { FilePlus2, LoaderCircle, Terminal } from 'lucide-react';
import type { FileEntry, Wire } from './types';
import { applyCompletion, commandSuggestions, completionAt, completionKeyAction } from './completions.mjs';
import './composer-completions.css';

type Props = {
  draft: string;
  setDraft: (text: string) => void;
  scope: string;
  ready: boolean;
  commands: Wire[];
  editor: RefObject<HTMLTextAreaElement | null>;
  onReference: (file: FileEntry) => boolean;
};
type Result = { key: string; files: FileEntry[]; truncated: boolean; error?: string };

export function useComposerCompletions({ draft, setDraft, scope, ready, commands, editor, onReference }: Props) {
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [choice, setChoice] = useState({ key: '', index: 0 });
  const list = useRef<HTMLDivElement>(null);
  const range = ready && focused && !composing ? completionAt(draft, selection.start, selection.end) : null;
  const key = range ? JSON.stringify([scope, draft, selection.start, selection.end, range.kind]) : '';
  const visible = !!range && key !== dismissed;
  const fileKey = visible && range.kind === 'file' ? key : '';
  const current = result?.key === fileKey ? result : null;
  const loading = !!fileKey && !current;
  const items: Wire[] = !visible ? [] : range.kind === 'command' ? commandSuggestions(commands, range.query) : current?.files || [];
  const index = choice.key === key ? Math.min(choice.index, Math.max(0, items.length - 1)) : 0;
  const menuOpen = visible && (range.kind === 'file' || items.length > 0);

  useEffect(() => {
    if (!fileKey || !range) return;
    let cancelled = false;
    const query = range.query;
    const timer = setTimeout(() => {
      void window.pi.searchFiles(query).then(response => {
        if (!cancelled) setResult({ key: fileKey, files: response.files, truncated: response.truncated });
      }).catch(error => {
        if (!cancelled) setResult({ key: fileKey, files: [], truncated: false, error: String(error) });
      });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [fileKey]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [key, index, items.length]);

  const updateSelection = (element: HTMLTextAreaElement) => {
    const next = { start: element.selectionStart, end: element.selectionEnd };
    setSelection(previous => previous.start === next.start && previous.end === next.end ? previous : next);
  };
  const accept = (item: Wire) => {
    if (!range || !menuOpen) return;
    if (range.kind === 'file' && !onReference(item as FileEntry)) return;
    const next = applyCompletion(draft, range, range.kind === 'file' ? item.path : item.name);
    setDismissed(key);
    setDraft(next.text);
    setSelection({ start: next.cursor, end: next.cursor });
    requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(next.cursor, next.cursor); });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!menuOpen || !range) return false;
    const exact = range.kind === 'command' && commands.some(command => `/${command.name}` === draft);
    const action = completionKeyAction({ ...event, key: event.key, isComposing: composing || event.nativeEvent.isComposing, keyCode: event.keyCode }, range.kind, items.length, loading, exact);
    if (!action) return false;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'dismiss') setDismissed(key);
    if (action === 'next' || action === 'previous') setChoice({ key, index: (index + (action === 'next' ? 1 : -1) + items.length) % items.length });
    if (action === 'accept') accept(items[index]);
    return true;
  };
  const menu = menuOpen && range ? (
    <div className="command-menu completion-menu" ref={list}>
      <div id="composer-completions" role="listbox" aria-label={range.kind === 'file' ? '文件引用' : '技能与命令'} aria-busy={loading}>
        {items.map((item, i) => <button type="button" tabIndex={-1} id={`composer-option-${i}`} role="option" aria-selected={i === index} className={i === index ? 'selected' : ''} key={range.kind === 'file' ? item.path : item.name} onMouseDown={event => event.preventDefault()} onClick={() => accept(item)}>
          {range.kind === 'file' ? <FilePlus2 size={14} /> : <Terminal size={14} />}
          <strong>{range.kind === 'file' ? item.name : `/${item.name}`}</strong><span>{range.kind === 'file' ? item.path : item.description}</span>
        </button>)}
      </div>
      {loading && <div className="completion-status" role="status"><LoaderCircle size={13} className="spin" />正在查找文件…</div>}
      {current?.error && <div className="completion-status" role="status">文件搜索失败：{current.error}</div>}
      {!loading && !current?.error && range.kind === 'file' && !items.length && <div className="completion-status" role="status">没有匹配的文件，可修改关键词或按 Esc 关闭</div>}
      {current?.truncated && <div className="completion-status">仅显示部分结果，请输入更完整的路径</div>}
      <div className="completion-help">↑ ↓ 选择 · Enter / Tab 补全 · Esc 关闭 · Shift Enter 换行</div>
    </div>
  ) : null;

  return {
    menu,
    onKeyDown,
    inputProps: {
      'aria-autocomplete': 'list' as const,
      'aria-controls': menuOpen ? 'composer-completions' : undefined,
      'aria-activedescendant': menuOpen && items.length ? `composer-option-${index}` : undefined,
      onFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => { setFocused(true); updateSelection(event.currentTarget); },
      onBlur: () => setFocused(false),
      onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => updateSelection(event.currentTarget),
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { setDraft(event.currentTarget.value); updateSelection(event.currentTarget); },
      onCompositionStart: () => setComposing(true),
      onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => { setComposing(false); updateSelection(event.currentTarget); },
    },
  };
}
