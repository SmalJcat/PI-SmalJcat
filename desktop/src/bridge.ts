import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { PiApi, Wire } from './types';

export async function initializeBridge() {
  // Retain the Electron bridge for the verified fallback and comparative tests.
  if (!isTauri()) {
    if (!window.pi) throw new Error('请从 Pi Desktop 应用中打开此界面。');
    return;
  }
  type Envelope = { generation: number; event: Wire };
  const subscribers = new Set<(event: Envelope) => void>();
  const events = new Channel<Envelope>();
  events.onmessage = payload => { for (const listener of subscribers) listener(payload); };
  const call = <T,>(operation: string, payload: Wire = {}) => invoke<T>('pi_command', { operation, payload });
  const api: PiApi = {
    bootstrap: () => call('bootstrap'),
    connect: options => call('connect', options),
    snapshot: () => call('snapshot'),
    sessionAccess: path => call('session-access', { path }),
    mcpStatus: reconnect => call('mcp-status', { reconnect }),
    contextStatus: () => call('context-status'),
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
    revealWorkspace: () => call('reveal-workspace'),
    revealConfig: () => call('reveal-config'),
    openLink: url => call('open-link', { url }),
    exportSession: () => call('export'),
    diagnostics: () => call('diagnostics'),
    window: action => call('window', { action }),
    onEvent: callback => { subscribers.add(callback); return () => { subscribers.delete(callback); }; },
  };
  // Register the ordered stream before React mounts and sends connect/bootstrap.
  await invoke('pi_subscribe', { events });
  window.pi = api;
}
