import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, LoaderCircle, RotateCcw, Search, Zap } from './icons';
import type { Model } from './types';

const labels: Record<string, string> = { off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
const keyOf = (model?: Model) => model ? `${model.provider}::${model.id}` : '';

export function ComposerModelControl({ models, model, levels, level, ready, locked, onModelChange, onLevelChange, onError }: {
  models: Model[]; model?: Model; levels: string[]; level: string; ready: boolean; locked: boolean;
  onModelChange: (model: Model) => Promise<void>; onLevelChange: (level: string) => Promise<void>; onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false), [showModels, setShowModels] = useState(false), [query, setQuery] = useState('');
  const [pending, setPending] = useState(false), [draft, setDraft] = useState(level);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 360, maxHeight: 520 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false), latestLevel = useRef(level);
  latestLevel.current = level;
  const id = useId();
  const choices = levels.length ? levels : ['off'];
  const index = Math.max(0, choices.indexOf(draft));
  const disabled = locked || pending || !ready;
  const filtered = models.filter(item => `${item.name} ${item.id} ${item.provider}`.toLowerCase().includes(query.trim().toLowerCase()));
  const close = (restoreFocus = false) => { setOpen(false); setShowModels(false); setQuery(''); if (restoreFocus) trigger.current?.focus(); };

  useEffect(() => { if (!pending) setDraft(level); }, [level, pending, model?.id, model?.provider]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => { if (showModels) search.current?.focus(); else panel.current?.querySelector<HTMLButtonElement>('.reasoning-model')?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [open, showModels]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor || !panel.current) return;
      const width = Math.min(360, window.innerWidth - 24), maxHeight = Math.min(520, window.innerHeight - 24);
      const height = Math.min(panel.current.scrollHeight, maxHeight);
      const top = anchor.top - height - 10;
      setPosition({ width, maxHeight, left: Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12)), top: Math.max(12, top >= 12 ? top : Math.min(anchor.bottom + 10, window.innerHeight - height - 12)) });
    };
    place();
    const resize = new ResizeObserver(place); if (panel.current) resize.observe(panel.current); if (trigger.current) resize.observe(trigger.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { resize.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, showModels, filtered.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      const node = event.target as Node;
      if (!panel.current?.contains(node) && !trigger.current?.contains(node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(true); }
    };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape, true); };
  }, [open]);

  const apply = async (action: () => Promise<void>) => {
    if (disabled || inFlight.current) return false;
    inFlight.current = true; setPending(true);
    try { await action(); return true; } catch (error) { onError(error); return false; }
    finally { inFlight.current = false; setPending(false); setDraft(latestLevel.current); }
  };
  const chooseLevel = (value: string) => {
    if (!choices.includes(value) || value === level || disabled) return;
    setDraft(value); void apply(() => onLevelChange(value));
  };
  const pick = async (next: Model) => {
    if (keyOf(next) !== keyOf(model) && !await apply(() => onModelChange(next))) return;
    setShowModels(false); setQuery('');
    panel.current?.querySelector<HTMLButtonElement>('.reasoning-model')?.focus();
  };
  const moveOption = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') || []);
    const current = buttons.indexOf(event.currentTarget);
    const next = event.key === 'ArrowDown' ? (current + 1) % buttons.length : event.key === 'ArrowUp' ? (current - 1 + buttons.length) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
  };

  return <>
    <button ref={trigger} className={`composer-reasoning-trigger ${open ? 'active' : ''}`} type="button" aria-label="模型与推理强度" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={!ready} title={`${model?.name || model?.id || '选择模型'} · ${labels[level] || level}`} onClick={() => { if (open) close(); else { setDraft(level); setOpen(true); } }}>
      {pending ? <LoaderCircle size={16} className="spin" /> : <Zap size={16} />}<span className="composer-current-model">{model?.name || model?.id || '选择模型'}</span>{levels.length > 0 && <span className="composer-current-level">{labels[level] || level}</span>}<ChevronDown size={14} />
    </button>
    {open && createPortal(<div ref={panel} id={id} className="reasoning-popover" role="dialog" aria-label="模型与推理设置" aria-modal="false" style={position}>
      <div className="reasoning-heading"><Zap size={18} /><div><strong aria-live="polite">{pending ? <LoaderCircle size={18} className="spin" /> : labels[draft] || draft}</strong><button type="button" className="reasoning-model" aria-label="选择模型" aria-expanded={showModels} disabled={disabled} onClick={() => setShowModels(value => !value)}>{model?.name || model?.id || '选择模型'}<ChevronRight size={14} /></button></div><button type="button" className="reasoning-reset" title="设为中等推理" aria-label="设为中等推理" disabled={disabled || !choices.includes('medium')} onClick={() => chooseLevel('medium')}><RotateCcw size={18} /></button></div>
      <div className="reasoning-range" style={{ '--reasoning-fill': `${choices.length > 1 ? index / (choices.length - 1) * 100 : 0}%` } as React.CSSProperties}>
        <div className="reasoning-dots" aria-hidden="true">{choices.map(value => <i key={value} />)}</div>
        <input type="range" aria-label="推理强度" aria-valuetext={labels[draft] || draft} min={0} max={Math.max(1, choices.length - 1)} step={1} value={index} disabled={disabled || choices.length < 2} onChange={event => setDraft(choices[Number(event.currentTarget.value)] || choices[0])} onPointerUp={event => chooseLevel(choices[Number(event.currentTarget.value)] || choices[0])} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) chooseLevel(choices[Number(event.currentTarget.value)] || choices[0]); }} onBlur={event => chooseLevel(choices[Number(event.currentTarget.value)] || choices[0])} />
      </div>
      {showModels && <div className="reasoning-model-picker"><label className="reasoning-search"><Search size={15} /><input ref={search} aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); panel.current?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)')?.focus(); } }} /></label><div className="reasoning-model-list" role="listbox" aria-label="可用模型">{filtered.map(item => <button type="button" role="option" aria-selected={keyOf(item) === keyOf(model)} data-model-key={keyOf(item)} key={keyOf(item)} disabled={disabled} onKeyDown={moveOption} onClick={() => void pick(item)}><span><strong>{item.name || item.id}</strong><small>{item.provider}</small></span>{keyOf(item) === keyOf(model) && <Check size={16} />}</button>)}{!filtered.length && <p>没有匹配的模型</p>}</div></div>}
    </div>, document.body)}
  </>;
}
