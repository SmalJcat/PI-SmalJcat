import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { PiApi, Wire } from './types';

export async function initializeBridge() {
  // Retain the Electron bridge for the verified fallback and comparative tests.
  if (!isTauri()) {
    if (!window.pi) throw new Error('请从 Pi Desktop 应用中打开此界面。');
    return;
  }
  type Envelope = { generation: number; event: Wire; engine?: string };
  const subscribers = new Set<(event: Envelope) => void>();
  const acpSubscribers = new Set<(event: Wire) => void>();
  const events = new Channel<Envelope>();
  events.onmessage = payload => { if (payload.engine === 'antigravity') { for (const listener of acpSubscribers) listener(payload.event); } else { for (const listener of subscribers) listener(payload); } };
  const call = <T,>(operation: string, payload: Wire = {}) => invoke<T>('pi_command', { operation, payload });
  const api: PiApi = {
    antigravity: (options = {}) => call('antigravity', options),
    onAntigravity: callback => { acpSubscribers.add(callback); return () => { acpSubscribers.delete(callback); }; },
    bootstrap: () => call('bootstrap'),
    connect: options => call('connect', options),
    snapshot: () => call('snapshot'),
    prepareMessageEdit: options => call('prepare-message-edit',options),
    sessionAccess: path => call('session-access', { path }),
    mcpStatus: reconnect => call('mcp-status', { reconnect }),
    contextStatus: () => call('context-status'),
    contextUsage: () => call('context-usage'),
    permissions: (options = {}) => call('permissions',options),
    contextConfigure: patch => call('context-settings', patch),
    agentTasks: (data = {}) => call('agent-tasks', data),
    searchFiles: query => call('search-files', { query }),
    review: (relative, stage) => call('review', { relative, stage }),
    openEditor: (relative, line) => call('open-editor', { relative, line }),
    sessions: cwd => call('sessions', { cwd }),
    chooseWorkspace: () => call('choose-workspace'),
    chooseExecutable: () => call('choose-executable'),
    command: (type, data = {}) => call('command', { type, data }),
    stop: () => call('stop'),
    respond: response => call('dialog', response),
    files: relative => call('files', { relative }),
    preview: relative => call('preview', { relative }),
    changes: () => call('changes'),
    diff: relative => call('diff', { relative }),
    attachments: paths => call('attachments', { paths }),
    chooseAttachments: () => call('choose-attachments'),
    pathForFile: () => '', // Native drag/drop delivers paths; File objects have none in WebView2.
    onFileDrop: callback => {
      let disposed = false;
      const registration = getCurrentWebview().onDragDropEvent(event => {
        if (disposed) return;
        if (event.payload.type === 'drop') callback({ type: 'drop', paths: event.payload.paths });
        else callback({ type: event.payload.type });
      });
      return () => { disposed = true; void registration.then(unlisten => unlisten()); };
    },
    revealWorkspace: cwd => call('reveal-workspace', { cwd }),
    revealConfig: () => call('reveal-config'),
    openLink: url => call('open-link', { url }),
    exportSession: () => call('export'),
    diagnostics: () => call('diagnostics'),
    extensionsList: (options = {}) => call('extensions-list', options),
    mcpServers: () => call('mcp-servers'),
    mcpTools: options => call('mcp-tools', options),
    mcpCall: options => call('mcp-call', options),
    mcpDisconnect: name => call('mcp-disconnect', { name }),
    widgetCatalog: () => call('widget-catalog'),
    widgetOpen: options => call('widget-open', options),
    widgetAudit: limit => call('widget-audit', { limit }),
    widgetClose: widget => call('widget-close', { widget }),
    reviewWindowOpen: (options = {}) => call('review-window-open', options),
    terminalRun: options => call('terminal-run', options),
    terminalCancel: () => call('terminal-cancel'),
    terminalHistory: limit => call('terminal-history', { limit }),
    terminalClear: () => call('terminal-clear'),
    indexStats: () => call('index-stats'),
    indexSearch: options => call('index-search', options),
    indexRebuild: () => call('index-rebuild'),
    agentRoles: () => call('agent-roles'),
    worktreeList: () => call('worktree-list'),
    worktreeRemove: path => call('worktree-remove', { path }),
    systemStatus: () => call('system-status'),
    systemSet: options => call('system-set', options),
    systemNotify: options => call('system-notify', options),
    storageUsage: () => call('storage-usage'),
    storageClean: options => call('storage-clean', options),
    indexReset: () => call('index-reset'),
    indexSync: () => call('index-sync'),
    sessionSearch: options => call('session-search', options),
    sessionIndexSync: () => call('session-index-sync'),
    sessionIndexStats: () => call('session-index-stats'),
    startupReady: options => call('startup-ready', options),
    startupTrace: () => call('startup-trace'),
    retentionStatus: () => call('retention-status'),
    retentionSet: options => call('retention-set', options),
    retentionApply: options => call('retention-apply', options),
    crashStatus: () => call('crash-status'),
    crashReport: options => call('crash-report', options),
    crashClear: () => call('crash-clear'),
    updateStatus: () => call('update-status'),
    updateCheck: (options = {}) => call('update-check', options),
    updateDownload: () => call('update-download'),
    updateInstall: () => call('update-install'),
    window: action => call('window', { action }),
    onEvent: callback => { subscribers.add(callback); return () => { subscribers.delete(callback); }; },
  };
  // Register the ordered stream before React mounts and sends connect/bootstrap.
  await invoke('pi_subscribe', { events });
  window.pi = api;
}
