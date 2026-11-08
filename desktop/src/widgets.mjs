// MCP Apps 沙箱宿主的纯逻辑：iframe 属性、消息校验、授权与审计展示。
// Rust 侧 mcp_apps.rs 是权威判定，这里只做「防线一」与展示。
export const MESSAGE_VERSION = 1;
export const HOST_CHANNEL = 'piHost';

// 只给 allow-scripts：不加 allow-same-origin，框架因此是不透明源，拿不到父页面 DOM 与存储。
export const SANDBOX_ATTRIBUTES = 'allow-scripts';

export const RISK_LABELS = { low: '低', medium: '中', high: '高' };

export const riskLabel = risk => RISK_LABELS[risk] || '未知';

// 默认不授予任何能力：授权必须由使用者逐项勾选。
export const initialGrants = () => [];

export const grantSummary = (allowed = [], denied = [], unknown = []) => ({
  allowed: allowed.length,
  denied: denied.length,
  unknown: unknown.length,
  text: `已授权 ${allowed.length} 项${denied.length ? `，未授权 ${denied.length} 项` : ''}${unknown.length ? `，未知能力 ${unknown.length} 项` : ''}`,
});

export const widgetFrameUrl = widgetId => `./widget-sandbox.html?widget=${encodeURIComponent(widgetId)}`;

// 宿主 -> widget：渲染指令。targetOrigin 用 * 是因为框架是不透明源，无法用具体 origin 匹配；
// 反向（widget -> 宿主）由 event.source 身份校验兜底。
export const buildRenderMessage = (widgetId, data = {}) => ({
  targetOrigin: '*',
  payload: { [HOST_CHANNEL]: MESSAGE_VERSION, widget: widgetId, data },
});

// 防线一：来源与形状校验。返回 ok 与原始消息，交给 Rust 侧做权威判定。
export function parseWidgetEvent(event, sourceWindow) {
  if (!sourceWindow) return { ok: false, reason: '框架还没有就绪' };
  if (event?.source !== sourceWindow) return { ok: false, reason: '来源不是该 widget 框架' };
  const data = event?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: '消息不是对象' };
  if (data.pi !== MESSAGE_VERSION) return { ok: false, reason: '消息不是 pi widget v1 协议' };
  if (typeof data.id !== 'string' || !data.id) return { ok: false, reason: '消息缺少调用 id' };
  if (typeof data.api !== 'string' || !data.api) return { ok: false, reason: '消息缺少 api' };
  return { ok: true, message: data };
}

// 界面侧预检：命中即不发往宿主，减少无谓往返；权威判定仍在 Rust。
export function preflight(message, granted = []) {
  if (!message) return { ok: false, reason: '消息为空' };
  if (!granted.includes(message.api)) return { ok: false, reason: `未授权的能力：${message.api}` };
  const size = JSON.stringify(message).length;
  if (size > 64 * 1024) return { ok: false, reason: '消息过大' };
  return { ok: true, size };
}

export const formatTime = atMs => {
  const value = Number(atMs);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const date = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export const auditTone = entry => (entry?.ok ? 'ok' : 'error');

// 审计里的 api 形如 "widget::api"，拆开便于在表格里对齐显示。
export const splitAuditApi = value => {
  const text = String(value || '');
  const index = text.indexOf('::');
  return index < 0 ? { widget: '', api: text } : { widget: text.slice(0, index), api: text.slice(index + 2) };
};
