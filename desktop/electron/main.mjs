import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { PiRpc } from './rpc.mjs';
import { agentDir, readJson, listSessions, sessionMetadata, branchMessages, listFiles, previewFile, gitChanges, gitDiff, attachmentsFromPaths } from './workspace.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
if (process.env.PI_DESKTOP_USER_DATA) app.setPath('userData', process.env.PI_DESKTOP_USER_DATA);
const preferencePath = path.join(app.getPath('userData'), 'preferences.json');
const isFixture = !app.isPackaged && process.env.PI_DESKTOP_TEST === '1';
let window, rpc, workspace, preferences, connecting = false, closing = false, generation = 0;
let commandBusy = false, lastState = {}, dialogs = new Map();
const busy = () => connecting || commandBusy || rpc?.busy;
const emit = event => { if (window && !window.isDestroyed()) window.webContents.send('pi:event', { generation, event }); };
function requireRpc() { if (!rpc || rpc.closed) throw new Error('Pi 未连接，请点击重新连接。'); return rpc; }
async function savePreferences(patch) {
  const next = { ...preferences, ...patch };
  await mkdir(path.dirname(preferencePath), { recursive: true });
  await writeFile(`${preferencePath}.tmp`, JSON.stringify(next, null, 2), 'utf8');
  await rename(`${preferencePath}.tmp`, preferencePath);
  preferences = next;
  return preferences;
}
async function findExecutable() {
  const candidates = [process.env.PI_DESKTOP_EXECUTABLE];
  for (const base of [app.getAppPath(), path.dirname(app.getPath('exe'))]) {
    for (let i = 0, parent = base; i < 5; i++, parent = path.dirname(parent)) candidates.push(path.join(parent, 'pi.exe'));
  }
  for (const candidate of candidates.filter(Boolean)) { try { await access(candidate); return candidate; } catch {} }
  return '';
}
const publicModel = model => model ? Object.fromEntries(['id', 'name', 'provider', 'reasoning', 'input', 'contextWindow'].map(key => [key, model[key]])) : undefined;
async function snapshot(client = requireRpc()) {
  const [state, history, models, levels, commands, stats] = await Promise.all([
    client.request('get_state'), client.request('get_entries'), client.request('get_available_models'),
    client.request('get_available_thinking_levels'), client.request('get_commands'), client.request('get_session_stats'),
  ]);
  lastState = state;
  client.busy = state.isStreaming || state.isCompacting;
  return { generation, cwd: workspace, state: { ...state, model: publicModel(state.model) }, messages: branchMessages(history.entries, history.leafId), models: models.models.map(publicModel), levels: levels.levels, commands: commands.commands, stats };
}
async function connect({ cwd, sessionPath, trust = false } = {}) {
  if (busy()) throw new Error('请先停止当前任务，再切换会话或工作区。');
  connecting = true;
  try {
    let target = path.resolve(cwd || preferences.lastWorkspace || path.dirname(preferences.executable) || app.getPath('home'));
    if (sessionPath) target = (await sessionMetadata(sessionPath)).cwd;
    if (!(await stat(target)).isDirectory()) throw new Error('工作区不存在或不是文件夹。');
    if (!isFixture) {
      if (!preferences.executable || !(await stat(preferences.executable)).isFile()) throw new Error('请在设置中选择本机 pi.exe。');
      if (process.platform === 'win32' && !preferences.executable.toLowerCase().endsWith('.exe')) throw new Error('请选择 Pi 可执行文件（.exe）。');
    }
    await rpc?.stop();
    generation++;
    dialogs.clear();
    workspace = target;
    lastState = {};
    const args = [...(sessionPath ? ['--session', sessionPath] : []), ...(trust ? ['--approve'] : [])];
    const client = isFixture
      ? new PiRpc('node', { cwd: target, prefixArgs: [path.join(directory, '../tests/fixture-pi.mjs')], args })
      : new PiRpc(preferences.executable, { cwd: target, args });
    rpc = client;
    client.on('event', event => {
      if (client !== rpc) return;
      if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
        dialogs.set(event.id, event);
        if (event.timeout) setTimeout(() => {
          if (client === rpc && dialogs.delete(event.id)) emit({ type: 'dialog_expired', id: event.id });
        }, event.timeout).unref();
      }
      emit(event);
    });
    const result = await snapshot(client);
    const recentWorkspaces = [target, ...(preferences.recentWorkspaces || []).filter(item => item.toLowerCase() !== target.toLowerCase())].slice(0, 12);
    await savePreferences({ lastWorkspace: target, recentWorkspaces });
    return result;
  } catch (error) {
    await rpc?.stop();
    rpc = undefined;
    throw error;
  } finally { connecting = false; }
}
function handle(name, callback) {
  ipcMain.handle(`pi:${name}`, (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效客户端');
    return callback(...args);
  });
}
function registerHandlers() {
  handle('bootstrap', () => ({ preferences, agentDir, version: app.getVersion() }));
  handle('connect', connect);
  handle('snapshot', () => snapshot());
  handle('sessions', cwd => listSessions(cwd || workspace || preferences.lastWorkspace || app.getPath('home')));
  handle('choose-workspace', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择工作区', properties: ['openDirectory'], defaultPath: workspace });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('choose-executable', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择 pi.exe', properties: ['openFile'], filters: [{ name: 'Pi executable', extensions: ['exe'] }] });
    if (result.canceled) return null;
    await savePreferences({ executable: result.filePaths[0] });
    return preferences;
  });
  handle('command', async (type, data = {}) => {
    const client = requireRpc();
    const allowed = ['prompt', 'abort', 'clear_queue', 'set_model', 'set_thinking_level', 'set_session_name', 'compact'];
    if (!allowed.includes(type)) throw new Error('不支持的命令');
    if (connecting) throw new Error('Pi 正在连接');
    if (['set_model', 'set_thinking_level', 'set_session_name', 'compact'].includes(type) && busy()) throw new Error('请等待当前任务完成。');
    if (type === 'prompt') {
      if (typeof data.message !== 'string' || data.message.length > 2 * 1024 * 1024) throw new Error('消息为空或过长。');
      if (data.images && (!Array.isArray(data.images) || data.images.length > 8 || JSON.stringify(data.images).length > 30 * 1024 * 1024)) throw new Error('附件超过大小限制。');
    }
    const exclusive = !['abort', 'clear_queue'].includes(type);
    if (exclusive && commandBusy) throw new Error('上一个操作仍在处理中。');
    if (exclusive) commandBusy = true;
    try {
      const result = await client.request(type, data, type === 'compact' || type === 'prompt' ? 600000 : 120000);
      if (type === 'abort' || type === 'compact') {
        const state = await client.request('get_state');
        client.busy = state.isStreaming || state.isCompacting;
      }
      return result;
    } finally { if (exclusive) commandBusy = false; }
  });
  handle('stop', async () => {
    const client = requireRpc();
    for (const id of dialogs.keys()) await client.write({ type: 'extension_ui_response', id, cancelled: true });
    dialogs.clear();
    emit({ type: 'dialogs_cleared' });
    const queue = await client.request('clear_queue');
    await client.request('abort');
    client.busy = false;
    return queue;
  });
  handle('dialog', async response => {
    if (!dialogs.has(response.id)) throw new Error('这个请求已经过期。');
    await requireRpc().write({ ...response, type: 'extension_ui_response' });
    dialogs.delete(response.id);
  });
  handle('files', relative => listFiles(workspace, relative));
  handle('preview', relative => previewFile(workspace, relative));
  handle('changes', () => gitChanges(workspace));
  handle('diff', relative => gitDiff(workspace, relative));
  handle('attachments', paths => attachmentsFromPaths(paths));
  handle('choose-attachments', async () => {
    const result = await dialog.showOpenDialog(window, { title: '添加文本或图片', properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : attachmentsFromPaths(result.filePaths);
  });
  handle('reveal-workspace', async cwd => {
    const target = cwd || workspace || preferences.lastWorkspace || app.getPath('home');
    if (typeof target !== 'string' || !path.isAbsolute(target) || !(await stat(target)).isDirectory()) throw new Error('项目文件夹不存在或不是绝对路径。');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return '';
  });
  handle('reveal-config', () => shell.openPath(agentDir));
  handle('open-link', async url => {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('仅支持打开 HTTP / HTTPS 链接。');
    await shell.openExternal(parsed.href);
  });
  handle('export', async () => {
    if (busy()) throw new Error('请等待任务完成再导出。');
    const result = await dialog.showSaveDialog(window, { title: '导出当前会话', defaultPath: 'pi-session.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (result.canceled) return null;
    const data = await requireRpc().request('export_html', { outputPath: result.filePath });
    shell.showItemInFolder(data.path);
    return data.path;
  });
  handle('diagnostics', () => ({ executable: preferences.executable, workspace, connected: !!rpc && !rpc.closed, stderr: rpc?.stderr || '', sessionFile: lastState.sessionFile }));
  handle('window', action => {
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    if (action === 'close') window.close();
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    preferences = await readJson(preferencePath, {});
    if (!preferences.executable) preferences.executable = await findExecutable();
    preferences.lastWorkspace ||= process.env.PI_DESKTOP_WORKSPACE || path.dirname(preferences.executable) || app.getPath('home');
    Menu.setApplicationMenu(null);
    window = new BrowserWindow({
      width: 1440, height: 940, minWidth: 960, minHeight: 640, title: 'Pi Desktop', backgroundColor: '#faf9f6',
      show: false, frame: false, icon: path.join(directory, 'icon.png'),
      webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    registerHandlers();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      const development = !app.isPackaged && process.env.PI_DESKTOP_DEV === '1';
      const csp = `default-src 'self'; script-src 'self'${development ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:5178; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`;
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
    window.once('ready-to-show', () => window.show());
    window.on('close', event => {
      if (closing) return;
      event.preventDefault();
      void (async () => {
        if (busy()) {
          const result = await dialog.showMessageBox(window, { type: 'question', message: '任务仍在运行，停止并关闭 Pi Desktop？', buttons: ['继续运行', '停止并关闭'], defaultId: 0, cancelId: 0 });
          if (result.response === 0) return;
        }
        closing = true;
        await rpc?.stop();
        window.destroy();
        app.quit();
      })();
    });
    if (!app.isPackaged && process.env.PI_DESKTOP_DEV === '1') await window.loadURL('http://127.0.0.1:5178');
    else await window.loadFile(path.join(directory, '../dist/index.html'));
  }).catch(error => { dialog.showErrorBox('Pi Desktop 启动失败', error.message); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => { if (!closing && window && !window.isDestroyed()) { event.preventDefault(); window.close(); } });
}
