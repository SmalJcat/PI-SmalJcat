// MCP 面板的纯展示与输入校验逻辑：不依赖 DOM，可在 Node 中直接测试。
export const TRANSPORT_LABELS = { stdio: '本地进程', http: 'HTTP', invalid: '定义无效' };

export const transportLabel = server => TRANSPORT_LABELS[server?.transport] || '未知传输';

export const serverStateLabel = server => {
  if (!server) return '未知';
  if (server.transport === 'invalid') return '定义无效';
  if (server.enabled === false) return '已禁用';
  return server.connected ? '已连接' : '未连接';
};

export const serverTone = server => {
  if (!server || server.transport === 'invalid') return 'error';
  if (server.enabled === false) return 'idle';
  return server.connected ? 'ok' : 'warn';
};

// 只返回与这个服务器相关的告警，避免把整份清单的告警挂到每一行上。
export const serverWarnings = (server, listing) => {
  const name = server?.name;
  if (!name) return [];
  return (listing?.warnings || []).filter(warning => String(warning).startsWith(name + '：') || String(warning).startsWith(name + ':'));
};

export const filterTools = (tools, query) => {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return tools || [];
  return (tools || []).filter(tool =>
    [tool?.name, tool?.description].filter(Boolean).some(value => String(value).toLowerCase().includes(needle)),
  );
};

// 输入 schema 在传输中被投影成 JSON 字符串；解析失败时返回空数组而不是抛错。
export const schemaFields = schema => {
  if (!schema) return [];
  let parsed = schema;
  if (typeof schema === 'string') {
    try {
      parsed = JSON.parse(schema);
    } catch {
      return [];
    }
  }
  const properties = parsed?.properties;
  if (!properties || typeof properties !== 'object') return [];
  const required = new Set(Array.isArray(parsed.required) ? parsed.required : []);
  return Object.entries(properties).map(([name, value]) => ({
    name,
    type: Array.isArray(value?.type) ? value.type.join('|') : String(value?.type || 'any'),
    required: required.has(name),
  }));
};

// 空文本按“无参数”处理；非对象一律拒绝，避免把数组/字符串当作参数送出去。
export function parseArguments(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { ok: true, value: {} };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, error: '参数不是合法 JSON：' + (error instanceof Error ? error.message : String(error)) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '参数必须是 JSON 对象，例如 {"text":"hello"}' };
  }
  return { ok: true, value: parsed };
}

// 按必填字段生成参数骨架，减少手写 JSON 的成本。
export function defaultArgumentsFor(tool) {
  const fields = schemaFields(tool?.inputSchema);
  const value = {};
  for (const field of fields) {
    if (!field.required) continue;
    value[field.name] = field.type === 'number' || field.type === 'integer' ? 0 : field.type === 'boolean' ? false : field.type === 'array' ? [] : '';
  }
  return JSON.stringify(value);
}

export const RESULT_PLACEHOLDERS = { image: '[图片内容]', audio: '[音频内容]', resource: '[资源引用]' };

export function formatCallResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const parts = [];
  for (const block of blocks) {
    const type = String(block?.type || '');
    if (type === 'text') parts.push(String(block.text ?? ''));
    else if (RESULT_PLACEHOLDERS[type]) parts.push(RESULT_PLACEHOLDERS[type]);
    else parts.push('[不支持的块：' + (type || 'unknown') + ']');
  }
  if (parts.length === 0) parts.push(JSON.stringify(result ?? null, null, 2));
  let text = parts.join('\n');
  if (result?.truncated) text += '\n…（结果过大，已截断）';
  return { isError: result?.isError === true, text };
}

export const callTone = result => (result?.isError === true ? 'error' : 'ok');
