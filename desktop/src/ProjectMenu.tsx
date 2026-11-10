import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Check, List, Pencil, Pin, PinOff } from 'lucide-react';
import { ChevronDown, ChevronRight, FolderOpen, MoreHorizontal, Plus, X } from './icons';

export type ProjectDetails = { path?: string; name?: string; pinned?: boolean; hidden?: boolean; section?: string };
export type ProjectSection = { id: string; name: string; collapsed?: boolean };

export function ProjectMenu({ name, details, sections, hidden, onUpdate, onEdit, onCreateSection, onManageSections, onOpenFolder, onArchives, onRemove }: {
  name: string; details: ProjectDetails; sections: ProjectSection[]; hidden?: boolean;
  onUpdate: (patch: ProjectDetails) => void; onEdit: () => void; onCreateSection: () => void;
  onManageSections: () => void; onOpenFolder: () => void; onArchives: () => void; onRemove: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [sectionMenu, setSectionMenu] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const close = (focus = true) => { setOpen(false); setSectionMenu(false); if (focus) trigger.current?.focus(); };
  useEffect(() => { if (hidden) close(false); }, [hidden]);
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current!.getBoundingClientRect(), box = popup.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8)), top: Math.max(48, Math.min(anchor.bottom + 4, window.innerHeight - box.height - 8)) });
  }, [open, sectionMenu, sections.length]);
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const pointer = (event: PointerEvent) => { if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false); };
    const dismiss = () => close(false);
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) dismiss(); };
    document.addEventListener('pointerdown', pointer);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('pointerdown', pointer); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', scroll, true); };
  }, [open]);
  const action = (fn: () => void) => { close(); fn(); };
  const item = (label: string, icon: ReactNode, fn: () => void) => <button role="menuitem" onClick={() => action(fn)}>{icon}<span>{label}</span></button>;
  return <>
    <button ref={trigger} className="project-new project-options" aria-label={`项目选项 ${name}`} title="项目选项" aria-haspopup="menu" aria-expanded={open} onClick={() => { if (open) close(); else { setOpen(true); setSectionMenu(false); } }}><MoreHorizontal size={16}/></button>
    {open && createPortal(<div ref={popup} className="project-options-menu" role="menu" aria-label={`${name} 项目选项`} style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'Tab') close(false);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const items = Array.from(popup.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')); const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}>
      {item(details.pinned ? '取消置顶' : '置顶', details.pinned ? <PinOff size={15}/> : <Pin size={15}/>, () => onUpdate({ pinned: !details.pinned }))}
      {item('编辑', <Pencil size={15}/>, onEdit)}
      <div className="project-menu-separator" role="separator"/>
      <button role="menuitem" aria-expanded={sectionMenu} aria-controls="project-section-options" onClick={() => setSectionMenu(value => !value)}><List size={15}/><span>分区</span>{sectionMenu ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button>
      {sectionMenu && <div className="project-section-options" id="project-section-options" role="group" aria-label="选择分区">
        <button role="menuitemradio" aria-checked={!details.section} onClick={() => action(() => onUpdate({ section: '' }))}><span>未分区</span>{!details.section && <Check size={13}/>}</button>
        {sections.map(section => <button key={section.id} role="menuitemradio" aria-checked={details.section === section.id} onClick={() => action(() => onUpdate({ section: section.id }))}><span>{section.name}</span>{details.section === section.id && <Check size={13}/>}</button>)}
        {item('新建分区…', <Plus size={14}/>, onCreateSection)}
        {sections.length > 0 && item('管理分区…', <Pencil size={14}/>, onManageSections)}
      </div>}
      {item('在资源管理器中打开', <FolderOpen size={15}/>, onOpenFolder)}
      <div className="project-menu-separator" role="separator"/>
      {item('归档聊天', <Archive size={15}/>, onArchives)}
      <div className="project-menu-separator" role="separator"/>
      {item(details.hidden ? '恢复项目' : '移除项目', <X size={15}/>, details.hidden ? () => onUpdate({ hidden: false }) : onRemove)}
    </div>, document.body)}
  </>;
}
