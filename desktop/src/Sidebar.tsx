import { useEffect, useState, type ReactNode } from 'react';
import { Archive, ArchiveRestore } from 'lucide-react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, MessageSquare, Plus, Search, X } from './icons';
import type { Session } from './types';
import { Modal } from './components';
import { ProjectMenu, type ProjectDetails, type ProjectSection } from './ProjectMenu';

type SidebarPreferences = { pinned: string[]; collapsed: string[]; archived: string[]; projects: Record<string, ProjectDetails>; sections: ProjectSection[] };

const pathKey = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const storageKey = 'pi-sidebar-v1';
function readPreferences(): SidebarPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
    const strings = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [];
    const projects: Record<string, ProjectDetails> = {};
    for (const [key, item] of Object.entries(value.projects || {})) {
      if (!item || typeof item !== 'object') continue;
      const meta = item as ProjectDetails;
      projects[key] = { path: typeof meta.path === 'string' ? meta.path : undefined, name: typeof meta.name === 'string' ? meta.name : undefined, pinned: meta.pinned === true, hidden: meta.hidden === true, section: typeof meta.section === 'string' ? meta.section : undefined };
    }
    const sections = Array.isArray(value.sections) ? value.sections.filter((item: ProjectSection) => item && typeof item.id === 'string' && typeof item.name === 'string').map((item: ProjectSection) => ({ id: item.id, name: item.name, collapsed: item.collapsed === true })) : [];
    return { pinned: strings(value.pinned), collapsed: strings(value.collapsed), archived: strings(value.archived), projects, sections };
  } catch { return { pinned: [], collapsed: [], archived: [], projects: {}, sections: [] }; }
}
function Pin({ filled = false }: { filled?: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 4h8l-1 7 3 3v2H6v-2l3-3-1-7Z"/><path d="M12 16v5"/></svg>;
}

interface Props {
  cwd: string;
  recentWorkspaces: string[];
  sessions: Session[];
  activeId?: string;
  locked: boolean;
  search: string;
  onSearch: (value: string) => void;
  onConnect: (options: { cwd?: string; sessionPath?: string }) => void;
  onChooseWorkspace: () => void;
  navigation: ReactNode;
  footer: ReactNode;
  home: ReactNode;
  newChat: ReactNode;
  hidden?: boolean;
  onError: (error: unknown) => void;
  children: ReactNode;
}

export function Sidebar({ cwd, recentWorkspaces, sessions, activeId, locked, search, onSearch, onConnect, onChooseWorkspace, navigation, footer, home, newChat, children, hidden, onError }: Props) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [currentOnly, setCurrentOnly] = useState(false);
  const [archivedView, setArchivedView] = useState(false);
  const [searchCollapsed, setSearchCollapsed] = useState<string[]>([]);
  const [showRemoved, setShowRemoved] = useState(false);
  const [archiveProject, setArchiveProject] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'edit' | 'section' | 'remove'; path: string; value: string } | null>(null);
  const [manageSections, setManageSections] = useState(false);
  const [sectionNames, setSectionNames] = useState<Record<string, string>>({});
  const savePreferences = (next: typeof preferences) => {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setPreferences(next); return true; }
    catch (error) { onError(error); return false; }
  };
  useEffect(() => { setSearchCollapsed([]); }, [search]);
  const query = search.trim().toLowerCase();
  const projectName = (path: string) => preferences.projects[pathKey(path)]?.name || basename(path);
  const projectVisible = (path: string) => !preferences.projects[pathKey(path)]?.hidden || showRemoved;
  const updateProject = (path: string, patch: ProjectDetails) => savePreferences({ ...preferences, projects: { ...preferences.projects, [pathKey(path)]: { ...preferences.projects[pathKey(path)], path, ...patch } } });
  const matches = (session: Session) => `${session.name} ${session.cwd} ${projectName(session.cwd)}`.toLowerCase().includes(query);
  const pinnedKeys = new Set(preferences.pinned);
  const archivedKeys = new Set(preferences.archived);
  const includeSession = (path: string) => archivedKeys.has(pathKey(path)) === archivedView;
  const pinned = archivedView ? [] : sessions.filter(session => projectVisible(session.cwd) && !archivedKeys.has(pathKey(session.path)) && pinnedKeys.has(pathKey(session.path)) && matches(session) && (!currentOnly || pathKey(session.cwd) === pathKey(cwd)));
  const projects = new Map<string, { path: string; sessions: Session[] }>();
  for (const path of [cwd, ...recentWorkspaces, ...Object.values(preferences.projects).map(item => item.path || ''), ...sessions.map(session => session.cwd)]) {
    if (path && !projects.has(pathKey(path))) projects.set(pathKey(path), { path, sessions: [] });
  }
  for (const session of sessions) {
    if (includeSession(session.path) && (archivedView || !pinnedKeys.has(pathKey(session.path))) && matches(session)) projects.get(pathKey(session.cwd))?.sessions.push(session);
  }
  const groups = [...projects.entries()].filter(([key, project]) => projectVisible(project.path) && (!archiveProject || !archivedView || key === archiveProject) && (!currentOnly || key === pathKey(cwd)) && (!archivedView || project.sessions.length > 0) && (!query || project.sessions.length || `${projectName(project.path)} ${project.path}`.toLowerCase().includes(query)))
    .sort(([a], [b]) => Number(!!preferences.projects[b]?.pinned) - Number(!!preferences.projects[a]?.pinned));
  const sections = [
    { id: '__pinned', name: '置顶项目', collapsed: false, groups: groups.filter(([key]) => preferences.projects[key]?.pinned) },
    { id: '', name: preferences.sections.length ? '未分区' : '', collapsed: false, groups: groups.filter(([key]) => !preferences.projects[key]?.pinned && !preferences.sections.some(section => section.id === preferences.projects[key]?.section)) },
    ...preferences.sections.map(section => ({ ...section, groups: groups.filter(([key]) => !preferences.projects[key]?.pinned && preferences.projects[key]?.section === section.id) })),
  ];
  const removedCount = [...projects.values()].filter(project => preferences.projects[pathKey(project.path)]?.hidden).length;
  const togglePin = (session: Session) => {
    const key = pathKey(session.path);
    savePreferences({ ...preferences, pinned: preferences.pinned.includes(key) ? preferences.pinned.filter(item => item !== key) : [...preferences.pinned, key] });
  };
  const toggleArchive = (session: Session) => {
    const key = pathKey(session.path);
    savePreferences({ ...preferences, archived: archivedKeys.has(key) ? preferences.archived.filter(item => item !== key) : [...preferences.archived, key] });
  };
  const renderSession = (session: Session, isPinned = false) => <div className={`sidebar-session-row ${session.id === activeId ? 'active' : ''}`} key={session.path}>
    <button className={`session-item ${session.id === activeId ? 'active' : ''}`} disabled={locked} aria-current={session.id === activeId ? 'page' : undefined} onClick={() => onConnect({ sessionPath: session.path })} title={`${session.name}\n${session.cwd}\n${new Date(session.updatedAt).toLocaleString('zh-CN')}`}>
      {isPinned && <Pin filled />}<span><strong>{session.name || '未命名会话'}</strong></span>
    </button>
    <div className="session-actions">{!archivedView && <button className="session-pin" aria-label={`${isPinned ? '取消置顶' : '置顶'} ${session.name}`} title={isPinned ? '取消置顶' : '置顶会话'} aria-pressed={isPinned} onClick={() => togglePin(session)}><Pin filled={isPinned}/></button>}
      <button className="session-archive" aria-label={`${archivedView ? '恢复' : '归档'} ${session.name}`} title={archivedView ? '恢复会话' : '归档会话'} onClick={() => toggleArchive(session)}>{archivedView ? <ArchiveRestore size={14}/> : <Archive size={14}/>}</button>
    </div>
  </div>;

  return <><aside className="sidebar project-sidebar" aria-label="项目与会话" hidden={hidden}>
    <nav className="sidebar-rail" aria-label="功能导航">{home}{navigation}<div className="sidebar-rail-bottom">{footer}</div></nav>
    <div className="sidebar-browser">
      <div className="sidebar-heading"><strong>Pi</strong><span>工作空间</span></div>
      <div className="sidebar-top">{newChat}<div className="search-box"><Search size={16}/><input aria-label="搜索会话" placeholder="搜索会话" value={search} onChange={event => onSearch(event.target.value)}/>{search && <button title="清空搜索" aria-label="清空搜索" onClick={() => onSearch('')}><X size={13}/></button>}</div></div>
      <div className="sidebar-scroll">
        <nav className="session-list" aria-label="历史会话">
          {pinned.length > 0 && <section className="sidebar-pinned" aria-label="置顶会话"><div className="sidebar-section-label">置顶</div>{pinned.map(session => renderSession(session, true))}</section>}
          <div className="sidebar-section-label"><span>{archivedView ? '已归档' : '项目'}</span><div><button className="project-add archive-toggle" aria-label={archivedView ? '返回项目会话' : '查看已归档会话'} title={archivedView ? '返回项目会话' : '查看已归档会话'} aria-pressed={archivedView} onClick={() => { setArchivedView(value => !value); setArchiveProject(''); }}>{archivedView ? <Folder size={15}/> : <Archive size={15}/>}</button><button className="project-scope" aria-pressed={currentOnly} title={currentOnly ? '显示全部项目' : '仅显示当前项目'} onClick={() => setCurrentOnly(value => !value)}>{currentOnly ? '当前' : '全部'}</button><button className="project-add" aria-label="添加工作区" title="添加工作区" disabled={locked} onClick={onChooseWorkspace}><Plus size={15}/></button></div></div>
          {archivedView && archiveProject && <div className="project-archive-scope"><span>{projectName(projects.get(archiveProject)?.path || archiveProject)} · 归档聊天</span><button onClick={() => setArchiveProject('')}>全部项目</button></div>}
          {sections.filter(section => section.groups.length > 0).map(section => <section className="project-partition" key={section.id} aria-label={section.name || '项目列表'}>
            {section.name && <div className="project-partition-label"><button aria-expanded={!!query || !section.collapsed} disabled={!section.id || section.id === '__pinned'} onClick={() => savePreferences({ ...preferences, sections: preferences.sections.map(item => item.id === section.id ? { ...item, collapsed: !item.collapsed } : item) })}>{section.id === '__pinned' ? <Pin filled/> : section.collapsed && !query ? <ChevronRight size={12}/> : <ChevronDown size={12}/>}<span>{section.name}</span><small>{section.groups.length}</small></button></div>}
            {(query || !section.collapsed) && section.groups.map(([key, project]) => {
            const open = query ? !searchCollapsed.includes(key) : !preferences.collapsed.includes(key);
            const all = !!query || expanded.includes(key);
            // Keep the active conversation visible even when it is older than the preview.
            const shown = all ? project.sessions : project.sessions.filter((session, index) => index < 5 || session.id === activeId);
            return <section className="sidebar-project" key={key} aria-label={`项目 ${projectName(project.path)}`}>
              <div className={`project-heading ${key === pathKey(cwd) ? 'current' : ''}`}>
                <button className="project-toggle" aria-expanded={open} title={project.path} onClick={() => query ? setSearchCollapsed(previous => open ? [...previous, key] : previous.filter(item => item !== key)) : savePreferences({ ...preferences, collapsed: open ? [...preferences.collapsed, key] : preferences.collapsed.filter(item => item !== key) })}>
                  <span className="project-folder">{open ? <FolderOpen size={17}/> : <Folder size={17}/>}</span><strong>{projectName(project.path)}</strong>{preferences.projects[key]?.hidden && <small className="removed-project-label">已移除</small>}{open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
                </button>
                <ProjectMenu name={projectName(project.path)} details={preferences.projects[key] || {}} sections={preferences.sections} hidden={hidden}
                  onUpdate={patch => { updateProject(project.path, patch); }}
                  onEdit={() => setDialog({ kind: 'edit', path: project.path, value: projectName(project.path) })}
                  onCreateSection={() => setDialog({ kind: 'section', path: project.path, value: '' })}
                  onManageSections={() => { setSectionNames(Object.fromEntries(preferences.sections.map(item => [item.id, item.name]))); setManageSections(true); }}
                  onOpenFolder={() => void window.pi.revealWorkspace(project.path).catch(onError)}
                  onArchives={() => { setArchivedView(true); setArchiveProject(key); setCurrentOnly(false); onSearch(''); savePreferences({ ...preferences, collapsed: preferences.collapsed.filter(item => item !== key), sections: preferences.sections.map(item => ({ ...item, collapsed: false })) }); }}
                  onRemove={() => setDialog({ kind: 'remove', path: project.path, value: projectName(project.path) })}/>
                <button className="project-new" disabled={locked} aria-label={`在 ${projectName(project.path)} 中新建会话`} title={`新会话 · ${project.path}`} onClick={() => onConnect({ cwd: project.path })}><Plus size={14}/></button>
              </div>
              {open && <div className="project-sessions">{shown.map(session => renderSession(session))}{!project.sessions.length && <button className="project-empty" disabled={locked} onClick={() => onConnect({ cwd: project.path })}>{query ? '新建会话' : '开始新会话'}</button>}{project.sessions.length > shown.length && <button className="project-more" onClick={() => setExpanded(previous => [...previous, key])}>显示更多 · {project.sessions.length - shown.length}</button>}{all && !query && project.sessions.length > 5 && <button className="project-more" onClick={() => setExpanded(previous => previous.filter(item => item !== key))}>收起列表</button>}</div>}
            </section>;
          })}</section>)}
          {removedCount > 0 && <button className="project-more removed-projects" onClick={() => setShowRemoved(value => !value)}>{showRemoved ? '隐藏已移除项目' : `显示已移除项目 · ${removedCount}`}</button>}
          {!groups.length && !pinned.length && <div className="session-empty"><MessageSquare size={22}/><p>{query ? '没有找到匹配的会话' : archivedView ? '暂无已归档会话' : '从一个新想法开始'}</p><span>{query ? '试试其他关键词' : archivedView ? '归档会话会保留历史，可随时恢复' : '添加项目，开始对话'}</span></div>}
        </nav>
        {children}
      </div>
    </div>
  </aside>
    {dialog && !hidden && <Modal title={dialog.kind === 'edit' ? '编辑项目' : dialog.kind === 'section' ? '新建分区' : '移除项目'} onClose={() => setDialog(null)}>
      <form className="modal-body" onSubmit={event => {
        event.preventDefault(); let saved = false;
        if (dialog.kind === 'remove') saved = updateProject(dialog.path, { hidden: true });
        else if (dialog.kind === 'edit' && dialog.value.trim()) saved = updateProject(dialog.path, { name: dialog.value.trim() });
        else if (dialog.kind === 'section' && dialog.value.trim()) {
          const existing = preferences.sections.find(item => item.name.toLocaleLowerCase() === dialog.value.trim().toLocaleLowerCase());
          const id = existing?.id || crypto.randomUUID();
          saved = savePreferences({ ...preferences, sections: existing ? preferences.sections : [...preferences.sections, { id, name: dialog.value.trim() }], projects: { ...preferences.projects, [pathKey(dialog.path)]: { ...preferences.projects[pathKey(dialog.path)], path: dialog.path, section: id } } });
        }
        if (saved) setDialog(null);
      }}>
        {dialog.kind === 'remove' ? <p className="dialog-message">从侧栏移除「{dialog.value}」？项目文件、会话和归档记录都会保留，可通过“显示已移除项目”恢复。</p> : <><label className="field-label" htmlFor="project-display-name">{dialog.kind === 'edit' ? '项目名称' : '分区名称'}</label><input id="project-display-name" className="dialog-input" data-autofocus maxLength={80} value={dialog.value} onChange={event => setDialog({ ...dialog, value: event.target.value })}/>{dialog.kind === 'edit' && <p className="project-path-hint">{dialog.path}<br/>仅修改显示名称，文件夹路径保持不变。</p>}</>}
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setDialog(null)}>取消</button><button className="primary-button" type="submit" disabled={dialog.kind !== 'remove' && !dialog.value.trim()}>{dialog.kind === 'remove' ? '移除项目' : '保存'}</button></div>
      </form>
    </Modal>}
    {manageSections && !hidden && <Modal title="管理分区" onClose={() => setManageSections(false)}><div className="modal-body"><p className="setting-help">删除分区后，其中的项目会回到“未分区”。</p>{preferences.sections.map(section => <div className="project-section-editor" key={section.id}><input className="dialog-input" aria-label={`分区名称 ${section.name}`} maxLength={80} value={sectionNames[section.id] ?? section.name} onChange={event => setSectionNames(values => ({ ...values, [section.id]: event.target.value }))}/><button className="secondary-button" onClick={() => savePreferences({ ...preferences, sections: preferences.sections.filter(item => item.id !== section.id), projects: Object.fromEntries(Object.entries(preferences.projects).map(([key, meta]) => [key, meta.section === section.id ? { ...meta, section: '' } : meta])) })}>删除 {section.name}</button></div>)}<div className="modal-actions"><button className="primary-button" onClick={() => { const names = preferences.sections.map(section => (sectionNames[section.id] ?? section.name).trim()); if (names.some(name => !name) || new Set(names.map(name => name.toLocaleLowerCase())).size !== names.length) { onError('分区名称不能为空或重复'); return; } if (savePreferences({ ...preferences, sections: preferences.sections.map((section, index) => ({ ...section, name: names[index] })) })) setManageSections(false); }}>保存分区</button></div></div></Modal>}
  </>;
}
