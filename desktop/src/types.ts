export type Wire = Record<string, any>;
export interface Model { id: string; name: string; provider: string; reasoning: boolean; input: string[]; contextWindow: number }
export interface Preferences { executable: string; lastWorkspace: string; recentWorkspaces?: string[] }
export interface Session { path: string; id: string; cwd: string; name: string; updatedAt: number }
export interface Attachment { name: string; path?: string; size: number; text?: string; mimeType?: string; data?: string }
export interface FileEntry { name: string; path: string; directory: boolean }
export interface Preview { path: string; content: string; truncated?: boolean; diff?: boolean }
export interface Changes { available: boolean; branch: string; files: { path: string; status: string; previous?: string }[]; reason?: string }
export interface Snapshot { generation: number; cwd: string; state: Wire; messages: Wire[]; models: Model[]; levels: string[]; commands: Wire[]; stats: Wire }
export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'ready' | 'up_to_date' | 'failed';
  currentVersion: string;
  availableVersion?: string | null;
  progressPercent: number;
  downloadedBytes: number;
  totalBytes: number;
  error: string;
  reason: string;
  source?: string | null;
  sourceConfigured?: boolean;
  notes?: string | null;
  lastCheckedAtMs?: number | null;
  stagedPath?: string | null;
  canCheck?: boolean;
  canDownload?: boolean;
  canInstall?: boolean;
}
export interface ExtensionEntry {
  id: string;
  name: string;
  version: string;
  entry: string;
  permissions: string[];
  description?: string | null;
  pi?: string | null;
  homepage?: string | null;
  directory: string;
  path: string;
  verdict: 'verified' | 'untrusted-key' | 'invalid' | 'unsigned' | 'broken';
  error: string;
  signature?: { algorithm: string; keyId: string } | null;
  entrySha256: string;
}
export interface ExtensionScan {
  root: string;
  trustedKeys: string[];
  extensions: ExtensionEntry[];
}
export interface PiApi {
  antigravity(options?: Wire): Promise<Wire>;
  onAntigravity(callback: (state: Wire) => void): () => void;
  bootstrap(): Promise<{ preferences: Preferences; agentDir: string; version: string; recovery?: {sessionPath: string; cwd: string; interrupted: boolean} | null }>;
  connect(options: { cwd?: string; sessionPath?: string; trust?: boolean; fork?: boolean }): Promise<Snapshot>;
  sessionAccess(path: string): Promise<{available: boolean; reason: string; canFork: boolean}>;
  mcpStatus(reconnect?: string): Promise<Wire>;
  contextStatus(): Promise<Wire>;
  contextUsage(): Promise<Wire>;
  permissions(options?: Wire): Promise<Wire>;
  contextConfigure(patch: Wire): Promise<Wire>;
  agentTasks(data?: Wire): Promise<Wire>;
  searchFiles(query: string): Promise<{files: FileEntry[]; truncated: boolean}>;
  review(relative: string, stage: 'working' | 'staged'): Promise<Wire>;
  openEditor(relative: string, line?: number): Promise<void>;
  snapshot(): Promise<Snapshot>;
  prepareMessageEdit(options: {sessionId:string;entryId:string}): Promise<{cancelled:boolean;snapshot?:Snapshot;text?:string}>;
  sessions(cwd?: string): Promise<Session[]>;
  chooseWorkspace(): Promise<string | null>;
  chooseExecutable(): Promise<Preferences | null>;
  command(type: string, data?: Wire): Promise<any>;
  stop(): Promise<{ steering: string[]; followUp: string[] }>;
  respond(response: Wire): Promise<void>;
  files(relative?: string): Promise<FileEntry[]>;
  preview(relative: string): Promise<Preview>;
  changes(): Promise<Changes>;
  diff(relative: string): Promise<Preview>;
  attachments(paths: string[]): Promise<Attachment[]>;
  chooseAttachments(): Promise<Attachment[]>;
  pathForFile(file: File): string;
  onFileDrop?(callback: (event: { type: string; paths?: string[] }) => void): () => void;
  revealWorkspace(cwd?: string): Promise<string>;
  revealConfig(): Promise<string>;
  openLink(url: string): Promise<void>;
  exportSession(): Promise<string | null>;
  diagnostics(): Promise<Wire>;
  mcpServers(): Promise<Wire>;
  mcpConnect(name: string): Promise<{ server: Wire }>;
  mcpResources(options: { name: string; cursor?: string }): Promise<Wire>;
  mcpResourceTemplates(options: { name: string; cursor?: string }): Promise<Wire>;
  mcpResourceRead(options: { name: string; uri: string }): Promise<Wire>;
  mcpPrompts(options: { name: string; cursor?: string }): Promise<Wire>;
  mcpPromptGet(options: { name: string; prompt: string; arguments: Record<string, string> }): Promise<Wire>;
  mcpTools(options: { name: string; refresh?: boolean }): Promise<{ server: Wire; tools: Wire[] }>;
  mcpCall(options: { name: string; tool: string; arguments: Wire }): Promise<Wire>;
  mcpDisconnect(name: string): Promise<{ disconnected: string[] }>;
  mcpAppPrepare(options: { name: string; tool: string }): Promise<Wire>;
  mcpAppOpen(options: { id: string; grantedTools: string[]; arguments: Wire; result: Wire }): Promise<Wire>;
  mcpAppClose(id: string): Promise<Wire>;
  widgetCatalog(): Promise<Wire>;
  widgetOpen(options: { widget: string; requested: string[]; granted: string[]; data?: Wire }): Promise<Wire>;
  widgetAudit(limit?: number): Promise<{ entries: Wire[] }>;
  widgetClose(widget: string): Promise<Wire>;
  reviewWindowOpen(options?: { file?: string; stage?: 'working' | 'staged' }): Promise<Wire>;
  terminalRun(options: { command: string; shell?: string }): Promise<Wire>;
  terminalCancel(): Promise<Wire>;
  terminalHistory(limit?: number): Promise<{ runs: Wire[]; busy: number | null }>;
  terminalClear(): Promise<Wire>;
  indexStats(): Promise<Wire>;
  indexSearch(options: Wire): Promise<{ items: Wire[]; total: number; page: number; pageSize: number; totalPages: number }>;
  indexRebuild(): Promise<{ summary: Wire; stats: Wire }>;
  agentRoles(): Promise<{ roles: Wire[] }>;
  worktreeList(): Promise<{ repo: string; worktrees: Wire[]; reason?: string }>;
  worktreeRemove(path: string): Promise<Wire>;
  systemStatus(): Promise<{ launchAtLogin: boolean; closeToTray: boolean; notifications: boolean }>;
  systemSet(options: Wire): Promise<{ launchAtLogin: boolean; closeToTray: boolean; notifications: boolean }>;
  systemNotify(options: { title: string; body?: string }): Promise<{ sent: boolean }>;
  storageUsage(): Promise<Wire>;
  storageClean(options: { target: string }): Promise<Wire>;
  indexReset(): Promise<{ stats: Wire }>;
  indexSync(): Promise<{ stats: Wire }>;
  sessionSearch(options: { query: string; limit?: number; sinceDays?: number; workspace?: string }): Promise<{ items: Wire[]; mode: string; total: number; terms?: string[]; firstSync?: Wire | null; stats?: Wire }>;
  sessionIndexSync(): Promise<{ summary: Wire; stats: Wire }>;
  sessionIndexStats(): Promise<{ stats: Wire; indexedTasks: number }>;
  startupReady(options: { renderMs: number }): Promise<{ startup: Wire; renderMs: number }>;
  startupTrace(): Promise<Wire>;
  retentionStatus(): Promise<Wire>;
  retentionSet(options: { days: number }): Promise<{ retentionDays: number }>;
  retentionApply(options: { ids: string[] }): Promise<{ removed: number; freedBytes: number; ids: string[] }>;
  crashStatus(): Promise<Wire>;
  crashReport(options: { message: string; detail?: string }): Promise<{ path: string }>;
  crashClear(): Promise<{ removed: number }>;
  extensionsList(options?: { dir?: string }): Promise<ExtensionScan>;
  updateStatus(): Promise<UpdateStatus>;
  updateCheck(options?: { manifest?: string }): Promise<UpdateStatus>;
  updateDownload(): Promise<UpdateStatus>;
  updateInstall(): Promise<UpdateStatus>;
  window(action: string): Promise<void>;
  onEvent(callback: (payload: { generation: number; event: Wire }) => void): () => void;
}
declare global { interface Window { pi: PiApi } }
