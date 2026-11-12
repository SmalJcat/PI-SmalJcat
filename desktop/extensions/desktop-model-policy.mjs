// Provider transport support, not a promise of account/server priority access.
const FAST_APIS = new Set(['openai-responses', 'openai-codex-responses', 'openai-completions']);
export const modelKey = model => model ? `${model.provider}/${model.id}` : '';
export const isSettingEntry = entry => ['model_change', 'thinking_level_change', 'session_info'].includes(entry.type)
  || (entry.type === 'custom' && entry.customType === 'desktop-fast-mode');
export const pendingEdit = entries => {
  const leaf = [...entries].reverse().find(entry => !isSettingEntry(entry));
  return leaf?.type === 'custom' && leaf.customType === 'desktop-message-edit' ? leaf : undefined;
};
export function fastChoices(entries) {
  const choices = Object.create(null);
  for (const entry of entries) {
    if (entry.type !== 'custom') continue;
    if (entry.customType === 'desktop-message-edit' && entry.data?.fastModes && typeof entry.data.fastModes === 'object') {
      for (const [key, enabled] of Object.entries(entry.data.fastModes)) if (typeof enabled === 'boolean') choices[key] = enabled;
    }
    if (entry.customType === 'desktop-fast-mode' && typeof entry.data?.modelKey === 'string' && typeof entry.data.enabled === 'boolean') {
      choices[entry.data.modelKey] = entry.data.enabled;
    }
  }
  return choices;
}
export function fastState(ctx) {
  const supported = FAST_APIS.has(ctx.model?.api);
  const key = modelKey(ctx.model);
  const choice = fastChoices(ctx.sessionManager.getBranch())[key];
  const configured = ['priority', 'fast'].includes(ctx.model?.samplingParams?.service_tier);
  return { supported, enabled: supported && (choice ?? configured), modelKey: key,
    reason: supported ? '请求优先处理，可能增加费用；是否生效取决于服务端与账号。' : '当前模型的传输不支持 Fast 服务档位。' };
}
export default function desktopModelPolicy(pi) {
  pi.on('session_before_compact', (event, ctx) => {
    // Pre-prompt checks run before Pi appends the replacement user message.
    // Once it is appended, subsequent turns use normal threshold protection.
    if (event.reason === 'threshold' && pendingEdit(ctx.sessionManager.getBranch())) return { cancel: true };
  });
  pi.on('before_provider_request', (event, ctx) => {
    if (!FAST_APIS.has(ctx.model?.api)) return;
    const choice = fastChoices(ctx.sessionManager.getBranch())[modelKey(ctx.model)];
    if (choice === undefined || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return;
    return { ...event.payload, service_tier: choice ? 'priority' : 'default' };
  });
  return {
    get: fastState,
    choices: ctx => fastChoices(ctx.sessionManager.getBranch()),
    set(ctx, options) {
      if (ctx.sessionManager.getSessionId() !== options.expectedSessionId) throw new Error('会话已切换，请重新设置 Fast');
      if (modelKey(ctx.model) !== options.modelKey) throw new Error('模型已切换，请重新设置 Fast');
      if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('请等待当前任务完成再设置 Fast');
      if (typeof options.enabled !== 'boolean') throw new Error('Fast 开关必须是布尔值');
      if (!fastState(ctx).supported) throw new Error('当前模型的传输不支持 Fast 服务档位');
      pi.appendEntry('desktop-fast-mode', { modelKey: options.modelKey, enabled: options.enabled });
      return fastState(ctx);
    },
  };
}
