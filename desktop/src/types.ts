export type Wire = Record<string, any>;
export interface Model { id: string; name: string; provider: string; reasoning: boolean; input: string[]; contextWindow: number }
export interface Preferences { executable: string; lastWorkspace: string; recentWorkspaces?: string[] }
export interface Session { path: string; id: string; cwd: string; name: string; updatedAt: number }
export interface Attachment { name: string; path?: string; size: number; text?: string; mimeType?: string; data?: string }
export interface FileEntry { name: string; path: string; directory: boolean }
export interface Preview { path: string; content: string; truncated?: boolean; diff?: boolean }
export interface Changes { available: boolean; branch: string; files: { path: string; status: string; previous?: string }[]; reason?: string }
export interface Snapshot { generation: number; cwd: string; state: Wire; messages: Wire[]; models: Model[]; levels: string[]; commands: Wire[]; stats: Wire }
export interface PiApi {
  bootstrap(): Promise<{ preferences: Preferences; agentDir: string; version: string; recovery?: {sessionPath: string; cwd: string; interrupted: boolean} | null }>;
  connect(options: { cwd?: string; sessionPath?: string; trust?: boolean; fork?: boolean }): Promise<Snapshot>;
  sessionAccess(path: string): Promise<{available: boolean; reason: string; canFork: boolean}>;
  mcpStatus(reconnect?: string): Promise<Wire>;
  contextStatus(): Promise<Wire>;
  contextConfigure(patch: Wire): Promise<Wire>;
  agentTasks(data?: Wire): Promise<Wire>;
  searchFiles(query: string): Promise<{files: FileEntry[]; truncated: boolean}>;
  review(relative: string, stage: 'working' | 'staged'): Promise<Wire>;
  openEditor(relative: string, line?: number): Promise<void>;
  snapshot(): Promise<Snapshot>;
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
  revealWorkspace(): Promise<string>;
  revealConfig(): Promise<string>;
  openLink(url: string): Promise<void>;
  exportSession(): Promise<string | null>;
  diagnostics(): Promise<Wire>;
  window(action: string): Promise<void>;
  onEvent(callback: (payload: { generation: number; event: Wire }) => void): () => void;
}
declare global { interface Window { pi: PiApi } }
