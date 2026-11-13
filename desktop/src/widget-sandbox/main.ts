// 沙箱 widget 页面：独立 WebView 窗口，只加载这一个页面。
// 它没有任何宿主持有能力：所有调用都必须经过 widget-invoke，由 Rust 侧按授权集合判定。
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { mountMcpApp } from '../mcp-app-frame.mjs';

type Wire = Record<string, any>;

// 身份由宿主按窗口标签下发，页面不依赖查询参数，也就无法自报成别的 widget。
function startDemo(identity: Wire) {
let widgetId = String(identity.widget || 'unknown');
let sequence = 0;
const nextId = () => `c${Date.now().toString(36)}-${++sequence}`;

const root = document.getElementById('root')!;
root.innerHTML = `
  <style>
    :root { color-scheme: dark; font-family: 'Segoe UI Variable', 'Microsoft YaHei UI', sans-serif; font-size: 13px; }
    body { margin: 0; padding: 14px 16px; background: #10161d; color: #dbe6ef; }
    h1 { font-size: 13px; margin: 0 0 4px; }
    .meta { font-size: 11px; color: #8ea3b5; margin-bottom: 12px; }
    .panel { border: 1px solid #26343f; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
    button { font: inherit; padding: 6px 10px; margin: 0 6px 6px 0; border-radius: 6px; border: 1px solid #2f4150; background: #17212b; color: inherit; cursor: pointer; }
    button:hover { background: #1d2a36; }
    button.danger { border-color: #5c3a3a; color: #ffb3af; }
    textarea { width: 100%; min-height: 54px; background: #0c1218; color: inherit; border: 1px solid #26343f; border-radius: 6px; padding: 7px; font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
    pre { margin: 6px 0 0; font-size: 11px; line-height: 1.6; white-space: pre-wrap; max-height: 180px; overflow: auto; color: #9fd8b4; }
    pre .error { color: #ffb3af; }
    .badge { display: inline-block; font-size: 10px; border: 1px solid #2f4150; border-radius: 999px; padding: 1px 7px; margin-left: 6px; color: #8ea3b5; }
  </style>
  <h1>沙箱 widget <span class="badge" id="widget-id"></span></h1>
  <div class="meta">这个窗口只有事件与 widget-invoke 两个通道，没有文件、进程或应用命令。</div>
  <div class="panel"><strong>宿主下发的数据</strong><pre id="host-data">（等待宿主下发）</pre></div>
  <div class="panel">
    <strong>数据</strong>
    <textarea id="value">{"city":"香港","temp":24}</textarea>
    <div style="margin-top:8px">
      <button id="set-data">上报数据（setWidgetData）</button>
      <button id="set-theme">切换主题（setTheme）</button>
      <button id="notify">上报工具结果（notifyMcpAppsToolResult）</button>
    </div>
  </div>
  <div class="panel">
    <strong>越权尝试</strong>
    <div class="meta">下面这些调用不在默认授权范围内，宿主应当拒绝并记入审计。</div>
    <button class="danger" id="escape-run">runUserCode</button>
    <button class="danger" id="escape-shot">screenshot</button>
    <button class="danger" id="escape-unknown">rm -rf 之类未知能力</button>
  </div>
  <pre id="log"></pre>
`;

const widgetBadge = document.getElementById('widget-id')!;
widgetBadge.textContent = widgetId;
const log = document.getElementById('log')!;
const hostData = document.getElementById('host-data')!;
const value = document.getElementById('value') as HTMLTextAreaElement;

const append = (text: string, error = false) => {
  const line = document.createElement('div');
  if (error) line.className = 'error';
  line.textContent = text;
  log.prepend(line);
};

/** 唯一出口：把调用交给 Rust 侧判定。 */
async function send(api: string, payload: Wire = {}) {
  const message = { pi: 1, id: nextId(), api, payload };
  try {
    const verdict: Wire = await invoke('widget_command', { operation: 'invoke', payload: { message: JSON.stringify(message) } });
    if (verdict.ok) append(`✓ ${api} → ${JSON.stringify(verdict.result)}`);
    else append(`✗ ${api} → ${verdict.error}`, true);
  } catch (error) {
    append(`✗ ${api} → ${String(error)}`, true);
  }
}

const parseValue = (): Wire => {
  try {
    const parsed = JSON.parse(value.value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

document.getElementById('set-data')!.addEventListener('click', () => void send('setWidgetData', { value: parseValue() }));
document.getElementById('set-theme')!.addEventListener('click', () => void send('setTheme', { theme: 'light' }));
document.getElementById('notify')!.addEventListener('click', () => void send('notifyMcpAppsToolResult', { result: parseValue() }));
document.getElementById('escape-run')!.addEventListener('click', () => void send('runUserCode', { code: 'process.exit(0)' }));
document.getElementById('escape-shot')!.addEventListener('click', () => void send('screenshot', {}));
document.getElementById('escape-unknown')!.addEventListener('click', () => void send('dropAllTables', {}));

void listen<Wire>('widget://render', event => {
  const data = event.payload?.data;
  hostData.textContent = JSON.stringify(data ?? null, null, 2);
  append('← 收到宿主下发数据');
});

widgetBadge.textContent = widgetId;
const allowed: string[] = Array.isArray(identity.allowed) ? identity.allowed : [];
append('已登记为 ' + widgetId + '，已授权 ' + allowed.length + ' 项');
}

void (async () => {
  let config: Wire;
  try {
    config = await invoke<Wire>('widget_command', {operation:'app-bootstrap'});
  } catch {
    const identity = await invoke<Wire>('widget_command', {operation:'identity'});
    startDemo(identity);
    return;
  }
  document.documentElement.style.colorScheme = 'dark';
  document.body.style.cssText = 'margin:0;font:13px system-ui;background:Canvas;color:CanvasText';
  const controller = mountMcpApp(document.getElementById('root')!, config,
    convertFileSrc(config.id, 'mcp-app'),
    (message: string) => invoke('widget_command', {operation:'app-rpc',payload:{message}}),
    () => invoke('widget_command', {operation:'app-close'}));
  await listen('widget://teardown', () => { void controller.dispose(); });
  if (config.resourceNotifications) {
    void controller.listenNotifications(()=>invoke<Wire>('widget_command',{operation:'app-notifications'}));
  }
})().catch(error => { document.getElementById('root')!.textContent = String(error); });
