import { readFile, readdir, stat, realpath, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JsonLines } from './rpc.mjs';

const exec = promisify(execFile);
export const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi', 'agent'));
export const expandPath = value => value.startsWith('~/') || value.startsWith('~\\') ? path.join(homedir(), value.slice(2)) : value;
export async function readJson(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`无法读取 ${file}：${error.message}`); }
}
export async function sessionRoot(cwd, configDirectory = agentDir) {
  const global = await readJson(path.join(configDirectory, 'settings.json'));
  const project = await readJson(path.join(cwd, '.pi', 'settings.json'));
  const custom = process.env.PI_CODING_AGENT_SESSION_DIR || project.sessionDir || global.sessionDir;
  return custom ? path.resolve(cwd, expandPath(custom)) : path.join(configDirectory, 'sessions');
}
const sessionCache = new Map();
export async function sessionMetadata(file) {
  const info = await stat(file);
  const cached = sessionCache.get(file);
  if (cached?.mtime === info.mtimeMs && cached?.size === info.size) return cached.value;
  let header, name, firstPrompt;
  const parser = new JsonLines(entry => {
    if (entry.type === 'session') header = entry;
    if (entry.type === 'session_info') name = entry.name;
    if (!firstPrompt && entry.type === 'message' && entry.message?.role === 'user') {
      const content = entry.message.content;
      firstPrompt = (typeof content === 'string' ? content : content?.filter(c => c.type === 'text').map(c => c.text).join(' ') || '').replace(/\s+/g, ' ').slice(0, 90);
    }
  });
  for await (const chunk of createReadStream(file)) parser.push(chunk);
  parser.end();
  if (!header?.cwd || !header.id) throw new Error('无效的 Pi 会话文件');
  const value = { path: file, id: header.id, cwd: header.cwd, name: name || firstPrompt || '未命名会话', updatedAt: info.mtimeMs };
  if (sessionCache.size > 1000) sessionCache.clear();
  sessionCache.set(file, { mtime: info.mtimeMs, size: info.size, value });
  return value;
}
export async function listSessions(cwd, configDirectory = agentDir) {
  const root = await sessionRoot(cwd, configDirectory);
  const files = [];
  async function visit(directory, depth) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 1) await visit(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  await visit(root, 0);
  const values = [];
  for (let i = 0; i < files.length; i += 8) {
    const batch = await Promise.allSettled(files.slice(i, i + 8).map(sessionMetadata));
    for (const item of batch) if (item.status === 'fulfilled') values.push(item.value);
  }
  return values.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 300);
}
export function branchMessages(entries, leafId) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch = [], seen = new Set();
  let current = leafId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) break;
    branch.push(entry);
    current = entry.parentId;
  }
  return branch.reverse().flatMap(entry => {
    if (entry.type === 'message') return [entry.message];
    if (entry.type === 'custom_message') return [{ ...entry, role: 'custom' }];
    if (entry.type === 'compaction') return [{ role: 'compactionSummary', summary: entry.summary, timestamp: Date.parse(entry.timestamp) }];
    if (entry.type === 'branch_summary') return [{ role: 'branchSummary', summary: entry.summary, timestamp: Date.parse(entry.timestamp) }];
    return [];
  });
}
export async function withinWorkspace(cwd, relative = '') {
  const root = await realpath(cwd);
  const target = await realpath(path.resolve(root, relative));
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('该路径位于当前工作区之外。');
  return target;
}
export async function listFiles(cwd, relative = '') {
  const directory = await withinWorkspace(cwd, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter(e => !e.isSymbolicLink() && !['.git', 'node_modules'].includes(e.name)).map(e => ({
    name: e.name, path: path.relative(cwd, path.join(directory, e.name)), directory: e.isDirectory(),
  })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}
export async function previewFile(cwd, relative) {
  const target = await withinWorkspace(cwd, relative);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('请选择文件。');
  const handle = await open(target, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(info.size, 256 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return { path: relative, content: '二进制文件，暂不支持文本预览。', truncated: false };
    return { path: relative, content: bytes.toString('utf8'), truncated: info.size > buffer.length };
  } finally { await handle.close(); }
}
export async function gitChanges(cwd) {
  try {
    cwd = await realpath(cwd);
    const { stdout } = await exec('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
    const { stdout: branch } = await exec('git', ['branch', '--show-current'], { cwd, windowsHide: true, timeout: 15000 });
    const root = await realpath((await exec('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true, timeout: 15000 })).stdout.trim());
    const records = stdout.split('\0');
    const files = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const status = record.slice(0, 2), file = record.slice(3);
      const previous = /[RC]/.test(status) ? records[++i] : undefined;
      const relativeFile = path.relative(cwd, path.join(root, file));
      if (relativeFile === '..' || relativeFile.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFile)) continue;
      files.push({ path: relativeFile, status, previous: previous ? path.relative(cwd, path.join(root, previous)) : undefined });
    }
    return { available: true, branch: branch.trim() || 'detached HEAD', files };
  } catch (error) {
    return { available: false, branch: '', files: [], reason: error.code === 'ENOENT' ? '未找到 Git' : '当前文件夹不在 Git 仓库中，或 Git 无法读取仓库。' };
  }
}
export async function gitDiff(cwd, relative) {
  // Deleted files cannot be realpath'ed; lexical containment still prevents path escape.
  const rel = path.relative(cwd, path.resolve(cwd, relative));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('无效文件路径');
  const results = await Promise.all([
    exec('git', ['diff', '--no-ext-diff', '--no-textconv', '--', rel], { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 }),
    exec('git', ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', rel], { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 }),
  ]);
  const content = results.map((r, i) => r.stdout ? `${i ? '已暂存' : '未暂存'}\n${r.stdout}` : '').filter(Boolean).join('\n');
  if (content) return { path: relative, content, diff: true };
  return previewFile(cwd, relative);
}
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export async function attachmentsFromPaths(paths) {
  if (!Array.isArray(paths) || paths.length > 8) throw new Error('一次最多添加 8 个附件。');
  const result = [];
  let total = 0;
  for (const file of paths) {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('附件必须是文件。');
    total += info.size;
    if (total > 20 * 1024 * 1024) throw new Error('附件总大小不能超过 20 MB。');
    const mimeType = imageTypes[path.extname(file).toLowerCase()];
    if (!mimeType && info.size > 256 * 1024) throw new Error(`文本附件 ${path.basename(file)} 超过 256 KB；请在消息中引用文件路径。`);
    const data = await readFile(file);
    if (!mimeType && data.includes(0)) throw new Error(`不支持的二进制附件：${path.basename(file)}`);
    result.push({ name: path.basename(file), path: file, size: info.size, ...(mimeType ? { mimeType, data: data.toString('base64') } : { text: data.toString('utf8') }) });
  }
  return result;
}
