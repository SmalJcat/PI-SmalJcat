import { useState } from 'react';
import type { ComponentType } from 'react';
import type { Preferences, Wire } from './types';
import { PiMark } from './components';
import { PRESETS } from './ui-theme.mjs';
import { CHAT_WIDTHS, DENSITIES, FONT_FAMILIES, FONT_SCALES, MOTIONS, RADIUS_SCALES } from './preferences.mjs';
import { UpdatePanel } from './UpdatePanel';
import { ExtensionsPanel } from './ExtensionsPanel';
import { McpToolsPanel } from './McpToolsPanel';
import { WidgetHostPanel } from './WidgetHostPanel';
import { IndexPanel } from './IndexPanel';
import { useEffect } from 'react';
import { Brain, Database, Download, FolderOpen, Keyboard, Layers, Plug, Settings2, ShieldCheck, Terminal, Zap } from './icons';
import { ACTIONS, comboFromEvent, findConflicts } from './shortcuts.mjs';
import { formatBytes } from './format.mjs';

// 设置对话框：左栏分区 + 右栏内容。
// 之前所有分区（外观/连接/更新/扩展/MCP/沙箱/索引/诊断）堆在一列滚动里，
// 六张卡片叠加后既难找也难读；改成两栏后每个分区只呈现自己的内容。
// 注意：连接分区是默认分区，且必须包含「重新连接 Pi」与「连接诊断」——
// 验收用例（tests/tauri-smoke.mjs）打开设置后直接点这两项。
type Section = 'connection' | 'appearance' | 'shortcuts' | 'system' | 'storage' | 'updates' | 'extensions' | 'mcp' | 'sandbox' | 'index';

const SECTIONS: { id: Section; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: 'connection', label: '连接', icon: Terminal },
  { id: 'appearance', label: '外观', icon: Settings2 },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'system', label: '系统', icon: Zap },
  { id: 'storage', label: '存储', icon: FolderOpen },
  { id: 'updates', label: '更新', icon: Download },
  { id: 'extensions', label: '扩展', icon: Layers },
  { id: 'mcp', label: 'MCP', icon: Plug },
  { id: 'sandbox', label: '沙箱', icon: ShieldCheck },
  { id: 'index', label: '索引', icon: Database },
];

// 与主窗口一致的 ANSI 清理（诊断输出里带终端控制序列）
const cleanAnsi = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

// 字节数展示走共享助手（src/format.mjs）


// 分段控件：ChatGPT 的设置里大量使用这种"一组互斥选项"的形态
function Choice({ label, options, value, onChange }: {
  label: string;
  options: { id: string; label: string; hint?: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const current = options.find(option => option.id === value);
  return (
    <div className="pref-row">
      <div className="pref-meta">
        <span className="pref-label">{label}</span>
        <span className="pref-hint">{current?.hint || current?.label || ""}</span>
      </div>
      <div className="pref-options" role="group" aria-label={label}>
        {options.map(option => (
          <button
            key={option.id}
            type="button"
            className={option.id === value ? "pref-option active" : "pref-option"}
            aria-pressed={option.id === value}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// 开关：用于布尔偏好
function Toggle({ label, hint, value, onChange }: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="pref-row pref-toggle">
      <span className="pref-meta">
        <span className="pref-label">{label}</span>
        <span className="pref-hint">{hint}</span>
      </span>
      <input type="checkbox" checked={value} onChange={event => onChange(event.target.checked)} />
    </label>
  );
}
export interface SettingsDialogProps {
  appVersion: string;
  preferences: Preferences;
  agentDirectory: string;
  trust: boolean;
  onTrustChange: (value: boolean) => void;
  locked: boolean;
  uiPreset: string;
  onPresetChange: (value: string) => void;
  uiPreferences: Wire;
  onPreference: (key: string, value: string | boolean) => void;
  shortcuts: Wire;
  /** 返回空串表示绑定成功，否则是拒绝原因（非法组合或与其它动作冲突）。 */
  onRebind: (actionId: string, combo: string) => string;
  onRestoreShortcuts: () => void;
  diagnostics: Wire;
  onClose: () => void;
  onError: (error: unknown) => void;
  onExecutableChange: (value: Preferences) => void;
  onReconnect: () => void;
  onChooseWorkspace: () => void;
}

export function SettingsDialog({
  appVersion,
  preferences,
  agentDirectory,
  trust,
  onTrustChange,
  locked,
  uiPreset,
  onPresetChange,
  uiPreferences,
  onPreference,
  shortcuts,
  onRebind,
  onRestoreShortcuts,
  diagnostics,
  onClose,
  onError,
  onExecutableChange,
  onReconnect,
  onChooseWorkspace,
}: SettingsDialogProps) {
  const [section, setSection] = useState<Section>('connection');
  // 系统集成状态来自 Rust（注册表与偏好文件），不在前端重复存储
  const [usage, setUsage] = useState<Wire>({ rows: [], totalBytes: 0 });
  const [storageNote, setStorageNote] = useState('');
  // 保留策略：记录清理必须先预览再确认（服务端也会按过期条件重新校验 id）
  const [crash, setCrash] = useState<Wire>({ cleanExit: true, crashCount: 0, rendererCount: 0, crashes: [], rendererErrors: [] });
  const loadCrash = () => {
    void window.pi.crashStatus().then(value => setCrash(value)).catch(onError);
  };
  const [retention, setRetention] = useState<Wire>({ retentionDays: 0, records: 0, recordBytes: 0, recordIds: [] });
  const [retentionNote, setRetentionNote] = useState('');
  const [confirmingClean, setConfirmingClean] = useState(false);
  const loadRetention = () => {
    void window.pi.retentionStatus().then(value => setRetention(value)).catch(onError);
  };
  const applyRetention = () => {
    setConfirmingClean(false);
    void window.pi
      .retentionApply({ ids: retention.recordIds || [] })
      .then(result => {
        setRetentionNote(`已删除 ${result.removed} 条归档记录，释放 ${formatBytes(Number(result.freedBytes) || 0)}`);
        loadRetention();
        loadUsage();
      })
      .catch(onError);
  };
  const loadUsage = () => {
    void window.pi.storageUsage().then(value => setUsage(value)).catch(onError);
  };
  useEffect(() => { loadUsage(); loadRetention(); loadCrash(); }, []);
  const runStorage = (target: string) => {
    setStorageNote('');
    void window.pi
      .storageClean({ target })
      .then(result => {
        setStorageNote(String(result?.note || '已清理') + '，释放 ' + formatBytes(Number(result?.freedBytes) || 0));
        loadUsage();
      })
      .catch(onError);
  };
  const runIndexReset = () => {
    setStorageNote('');
    void window.pi
      .indexReset()
      .then(() => { setStorageNote('索引已清空并从任务记录重建'); loadUsage(); })
      .catch(onError);
  };
  const [recording, setRecording] = useState('');
  const [shortcutError, setShortcutError] = useState('');
  // 录制时用捕获阶段的全局监听：按钮失焦也不会丢键，且先于应用的全局快捷键生效
  useEffect(() => {
    if (!recording) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { setRecording(''); setShortcutError(''); return; }
      const combo = comboFromEvent(event);
      if (!combo) return;
      const reason = onRebind(recording, combo);
      setShortcutError(reason);
      if (!reason) setRecording('');
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [recording, onRebind]);
  const conflicts = findConflicts(shortcuts);
  const [system, setSystem] = useState<Wire>({ launchAtLogin: false, closeToTray: false, notifications: false });
  const [systemBusy, setSystemBusy] = useState('');
  useEffect(() => {
    void window.pi
      .systemStatus()
      .then(value => setSystem(value))
      .catch(() => {});
  }, []);
  const applySystem = (key: string, value: boolean) => {
    setSystemBusy(key);
    setSystem(previous => ({ ...previous, [key]: value }));
    void window.pi
      .systemSet({ [key]: value })
      .then(value => setSystem(value))
      .catch(error => {
        setSystem(previous => ({ ...previous, [key]: !value }));
        onError(error);
      })
      .finally(() => setSystemBusy(''));
  };

  return (
    <div className="modal-body settings-body settings-split">
      <aside className="settings-nav" aria-label="设置分区">
        <div className="settings-nav-head">
          <PiMark small />
          <div>
            <strong>Pi Desktop</strong>
            <span>{appVersion}</span>
          </div>
        </div>
        {SECTIONS.map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={section === item.id ? 'settings-nav-item active' : 'settings-nav-item'}
              onClick={() => setSection(item.id)}
              aria-current={section === item.id}
            >
              <Icon size={15} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </aside>

      <section className="settings-content">
                {section === 'appearance' && (
          <>
            <h3 className="settings-title">外观</h3>
            <p className="setting-help">所有选项立即生效并记住；数值来源与规则见 docs/TYPOGRAPHY.md 与 docs/UI-THEME-CHATGPT.md。</p>
            <Choice
              label="界面风格"
              options={PRESETS.map(preset => ({ id: preset.id, label: preset.label, hint: preset.note }))}
              value={uiPreset}
              onChange={onPresetChange}
            />
            <Choice label="字号" options={FONT_SCALES} value={uiPreferences.fontScale} onChange={value => onPreference("fontScale", value)} />
            <Choice label="行高（中文正文）" options={DENSITIES} value={uiPreferences.density} onChange={value => onPreference("density", value)} />
            <Choice label="字体" options={FONT_FAMILIES} value={uiPreferences.fontFamily} onChange={value => onPreference("fontFamily", value)} />
            <Choice label="圆角" options={RADIUS_SCALES} value={uiPreferences.radius} onChange={value => onPreference("radius", value)} />
            <Choice label="对话宽度" options={CHAT_WIDTHS} value={uiPreferences.chatWidth} onChange={value => onPreference("chatWidth", value)} />
            <Choice label="动效" options={MOTIONS} value={uiPreferences.motion} onChange={value => onPreference("motion", value)} />
            <Toggle
              label="Enter 发送"
              hint={uiPreferences.enterToSend ? "Enter 发送 · Shift+Enter 换行" : "Ctrl/Cmd+Enter 发送 · Enter 换行"}
              value={uiPreferences.enterToSend}
              onChange={value => onPreference("enterToSend", value)}
            />
            <Toggle
              label="工具卡默认折叠"
              hint={uiPreferences.collapseTools ? "长工具输出默认收起，点击展开" : "工具输出默认展开"}
              value={uiPreferences.collapseTools}
              onChange={value => onPreference("collapseTools", value)}
            />
            <div className="settings-shortcuts">
              <span><kbd>Ctrl N</kbd> 新会话</span>
              <span><kbd>Ctrl O</kbd> 打开文件夹</span>
              <span><kbd>Esc</kbd> 停止任务</span>
              <span><kbd>Ctrl ,</kbd> 设置</span>
            </div>
          </>
        )}
{section === 'connection' && (
          <>
            <h3 className="settings-title">连接</h3>
            <label className="field-label">Pi 可执行文件</label>
            <div className="setting-path">
              <code>{preferences.executable || '未设置'}</code>
              <button
                className="secondary-button"
                disabled={locked}
                onClick={() => {
                  void window.pi
                    .chooseExecutable()
                    .then(value => { if (value) onExecutableChange(value); })
                    .catch(onError);
                }}
              >
                选择文件
              </button>
            </div>
            <label className="field-label">Pi 配置目录</label>
            <div className="setting-path">
              <code>{agentDirectory}</code>
              <button className="secondary-button" onClick={() => void window.pi.revealConfig().catch(onError)}>
                打开目录
              </button>
            </div>
            <p className="setting-help">模型、登录凭据、MCP 与扩展沿用 Pi 的配置；模型与思考强度可在输入框下方切换。</p>
            <label className="trust-option">
              <input type="checkbox" checked={trust} onChange={event => onTrustChange(event.target.checked)} />
              <span>
                本次连接加载当前项目的配置与扩展
                <small>默认遵循 Pi 已保存的信任设置。勾选后以 --approve 重新连接。</small>
              </span>
            </label>
            <div className="settings-actions">
              <button className="primary-button" disabled={locked} onClick={onReconnect}>重新连接 Pi</button>
              <button className="secondary-button" disabled={locked} onClick={onChooseWorkspace}>切换工作区</button>
            </div>
            <div className="pref-row">
              <div className="pref-meta">
                <span className="pref-label">崩溃诊断</span>
                <span className="pref-hint">
                  {crash.cleanExit ? '上次正常退出' : '上次异常退出（存在崩溃报告）'} · 崩溃 {Number(crash.crashCount) || 0} 份 · 前端错误 {Number(crash.rendererCount) || 0} 条
                </span>
              </div>
              <div className="shortcut-control">
                {Number(crash.crashCount) + Number(crash.rendererCount) > 0 && (
                  <button className="secondary-button" onClick={() => { void window.pi.crashClear().then(loadCrash).catch(onError); }}>清空报告</button>
                )}
                <button className="secondary-button" onClick={loadCrash}>刷新</button>
              </div>
            </div>
            {crash.dir && <p className="setting-help">报告目录（纯本地，不上报）：<code>{String(crash.dir)}</code></p>}
            {[...(crash.crashes || []), ...(crash.rendererErrors || [])].slice(0, 3).map((item: Wire) => (
              <p className="setting-help" key={String(item.name)}>{String(item.name)} · {String(item.preview || '')}</p>
            ))}
            <details className="diagnostics">
              <summary>连接诊断</summary>
              <pre>{JSON.stringify({ ...diagnostics, stderr: cleanAnsi(String(diagnostics.stderr || '')) }, null, 2)}</pre>
            </details>
          </>
        )}

        {section === 'shortcuts' && (
          <>
            <h3 className="settings-title">快捷键</h3>
            <p className="setting-help">点「录制」后直接按组合键；Esc 取消录制。与其它动作冲突或只按修饰键会被拒绝。</p>
            {conflicts.length > 0 && (
              <p className="setting-help shortcut-warning">
                有重复绑定：{conflicts.map(item => item.combo).join('、')} —— 同一组合键会命中列表里靠前的动作。
              </p>
            )}
            {ACTIONS.map(action => (
              <div className="pref-row" key={action.id}>
                <div className="pref-meta">
                  <span className="pref-label">{action.label}</span>
                  <span className="pref-hint">{recording === action.id ? '请按下组合键…' : action.hint}</span>
                </div>
                <div className="shortcut-control">
                  <kbd>{shortcuts[action.id]}</kbd>
                  <button
                    className={recording === action.id ? 'secondary-button recording' : 'secondary-button'}
                    onClick={() => { setShortcutError(''); setRecording(recording === action.id ? '' : action.id); }}
                  >
                    {recording === action.id ? '取消' : '录制'}
                  </button>
                </div>
              </div>
            ))}
            {shortcutError && <p className="setting-help shortcut-warning">{shortcutError}</p>}
            <div className="settings-actions">
              <button className="secondary-button" onClick={() => { setShortcutError(''); setRecording(''); onRestoreShortcuts(); }}>恢复默认快捷键</button>
            </div>
          </>
        )}
        {section === 'system' && (
          <>
            <h3 className="settings-title">系统</h3>
            <p className="setting-help">这三项由 Rust 侧落地（注册表与偏好文件），关闭应用后仍然有效。</p>
            <Toggle
              label="开机自启"
              hint="登录 Windows 后自动启动 Pi Desktop"
              value={Boolean(system.launchAtLogin)}
              onChange={value => applySystem('launchAtLogin', value)}
            />
            <Toggle
              label="关闭时最小化到托盘"
              hint="点关闭按钮只隐藏窗口，从托盘菜单才能真正退出；托盘图标在下次启动时创建"
              value={Boolean(system.closeToTray)}
              onChange={value => applySystem('closeToTray', value)}
            />
            <Toggle
              label="任务完成通知"
              hint="任务结束时发送系统通知（窗口在前台时不打扰）"
              value={Boolean(system.notifications)}
              onChange={value => applySystem('notifications', value)}
            />
            <div className="settings-actions">
              <button
                className="secondary-button"
                disabled={Boolean(systemBusy) || !system.notifications}
                onClick={() =>
                  void window.pi
                    .systemNotify({ title: 'Pi Desktop', body: '这是一条测试通知' })
                    .then(result => { if (!result?.sent) onError(new Error('通知未发送，请先打开任务完成通知')); })
                    .catch(onError)
                }
              >
                发送测试通知
              </button>
            </div>
          </>
        )}
        {section === 'storage' && (
          <>
            <h3 className="settings-title">存储</h3>
            <p className="setting-help">只统计应用自己管理的目录，合计 {formatBytes(Number(usage.totalBytes) || 0)}；索引中有 {Number(usage.indexedTasks) || 0} 条任务。</p>
            {(usage.rows || []).map((row: Wire) => (
              <div className="pref-row" key={row.id}>
                <div className="pref-meta">
                  <span className="pref-label">{row.label}</span>
                  <span className="pref-hint" title={String(row.path)}>{row.note || row.path}</span>
                </div>
                <div className="shortcut-control">
                  <span className="storage-size">{formatBytes(Number(row.bytes) || 0)}<small>{Number(row.files) || 0} 个文件</small></span>
                  {row.cleanable && <button className="secondary-button" onClick={() => runStorage(row.id)}>清理</button>}
                  {row.resettable && <button className="secondary-button" onClick={runIndexReset}>重建</button>}
                </div>
              </div>
            ))}
            <div className="pref-row">
              <div className="pref-meta">
                <span className="pref-label">归档保留期</span>
                <span className="pref-hint">超过保留期的「已归档任务」会列出来供清理；**会话原文永不被删除**</span>
              </div>
              <div className="shortcut-control">
                <select
                  aria-label="归档保留期"
                  value={String(Number(retention.retentionDays) || 0)}
                  onChange={event => {
                    setRetentionNote('');
                    void window.pi.retentionSet({ days: Number(event.target.value) }).then(loadRetention).catch(onError);
                  }}
                >
                  <option value="0">永久保留</option>
                  <option value="90">90 天</option>
                  <option value="180">180 天</option>
                  <option value="365">1 年</option>
                </select>
              </div>
            </div>
            {Number(retention.records) > 0 && (
              <div className="settings-actions">
                <span className="setting-help">超过保留期：{Number(retention.records)} 条 · {formatBytes(Number(retention.recordBytes) || 0)}</span>
                {confirmingClean
                  ? <>
                      <button className="primary-button" onClick={applyRetention}>确认删除 {Number(retention.records)} 条</button>
                      <button className="secondary-button" onClick={() => setConfirmingClean(false)}>取消</button>
                    </>
                  : <button className="secondary-button" onClick={() => setConfirmingClean(true)}>清理这些记录</button>}
              </div>
            )}
            {Number(retention.updateCacheFiles) > 0 && (
              <p className="setting-help">更新缓存中超过 7 天的文件：{Number(retention.updateCacheFiles)} 个（启动时自动清理）</p>
            )}
            {retentionNote && <p className="setting-help update-notice">{retentionNote}</p>}
            {storageNote && <p className="setting-help update-notice">{storageNote}</p>}
            <div className="settings-actions">
              <button className="secondary-button" onClick={() => { setStorageNote(''); void window.pi.indexSync().then(() => { setStorageNote('已把全部任务记录对齐到索引'); loadUsage(); }).catch(onError); }}>对齐索引</button>
              <button className="secondary-button" onClick={loadUsage}>重新统计</button>
            </div>
          </>
        )}
        {section === 'updates' && (<><h3 className="settings-title">更新</h3><UpdatePanel onError={onError} /></>)}
        {section === 'extensions' && (<><h3 className="settings-title">扩展</h3><ExtensionsPanel onError={onError} /></>)}
        {section === 'mcp' && (<><h3 className="settings-title">MCP</h3><McpToolsPanel onError={onError} /></>)}
        {section === 'sandbox' && (<><h3 className="settings-title">沙箱</h3><WidgetHostPanel onError={onError} /></>)}
        {section === 'index' && (<><h3 className="settings-title">索引</h3><IndexPanel onError={onError} /></>)}

        <div className="settings-footer">
          <button className="secondary-button" onClick={onClose}>关闭设置</button>
        </div>
      </section>
    </div>
  );
}
