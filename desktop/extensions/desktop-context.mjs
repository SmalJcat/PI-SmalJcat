// Runs inside Pi's extension host; no standalone Node.js runtime is required.
import { SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import desktopPermissions from './desktop-permissions.mjs';
import desktopModelPolicy, { pendingEdit } from './desktop-model-policy.mjs';

export default function desktopContext(pi) {
  desktopPermissions(pi);
  const modelPolicy = desktopModelPolicy(pi);
  const reportUsage = (_event, ctx) => {
    try {
      const usage = ctx.getContextUsage();
      ctx.ui.notify('PI_DESKTOP_USAGE:' + JSON.stringify({ usage: usage || null, modelKey: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '', window: ctx.model?.contextWindow || null, estimated: true }), 'info');
    } catch { /* Older/unknown hosts can still use the RPC statistics fallback. */ }
  };
  for (const event of ['session_start','session_switch','session_compact','model_select','agent_start','agent_end','agent_settled','message_end','turn_end']) pi.on(event, reportUsage);
  // Keep the same loaded settings snapshot as this Pi connection. Out-of-band
  // edits become effective when the extension runner is reloaded.
  let settingsSnapshot;
  let settingsScope;
  pi.registerCommand('desktop-context', {
    description: '读取桌面上下文配置或重新加载已保存的设置',
    handler: async (args, ctx) => {
      const [operation, nonce, ...payload] = args.trim().split(/\s+/);
      if (!['get', 'reload', 'edit', 'fast'].includes(operation) || !/^[a-f0-9-]{36}$/.test(nonce || '')) return;
      const prefix = `PI_DESKTOP_CONTEXT:${nonce}:`;
      try {
        if (operation === 'fast') {
          const fastMode = modelPolicy.set(ctx, JSON.parse(payload.join(' ')));
          ctx.ui.notify(prefix + JSON.stringify({ ok: true, fastMode }), 'info');
          return;
        }
        if (operation === 'edit') {
          const { sessionId, entryId } = JSON.parse(payload.join(' '));
          if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error('会话已切换，请重新选择要编辑的消息');
          if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('请先停止当前任务再编辑消息');
          // Pi may append model/thinking metadata while restoring this branch.
          const branch = ctx.sessionManager.getBranch();
          const leaf = pendingEdit(branch);
          if (leaf?.data?.entryId === entryId) {
            ctx.ui.notify(prefix + JSON.stringify({ ok: true, cancelled: false }), 'info');
            return;
          }
          const target = branch.find(entry => entry.id === entryId);
          if (target?.type !== 'message' || target.message.role !== 'user') throw new Error('该消息已不在当前会话分支中，请刷新后重新选择');
          // Selecting a user entry navigates to its parent, excluding the old prompt.
          const fastModes = modelPolicy.choices(ctx);
          const result = await ctx.navigateTree(entryId, { summarize: false });
          // Persist the selected leaf even if resending fails or the editor is closed.
          if (!result.cancelled) pi.appendEntry('desktop-message-edit', { entryId, fastModes });
          ctx.ui.notify(prefix + JSON.stringify({ ok: true, cancelled: !!result.cancelled }), 'info');
          return;
        }
        const projectTrusted = ctx.isProjectTrusted();
        // Reload invalidates this command context; the desktop reads the result
        // through a second command bound to the replacement extension runner.
        if (operation === 'reload') { await ctx.reload(); return; }
        const scope = `${ctx.cwd}:${projectTrusted}`;
        if (!settingsSnapshot || settingsScope !== scope) {
          settingsSnapshot = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted });
          settingsScope = scope;
        }
        const settings = settingsSnapshot;
        const errors = settings.drainErrors();
        if (errors.length) throw new Error('Pi 设置文件无法读取，请检查配置 JSON。');
        const key = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '';
        const project = settings.getProjectSettings().compaction;
        ctx.ui.notify(prefix + JSON.stringify({ ok: true, fastMode: modelPolicy.get(ctx), ...settings.getCompactionSettings(ctx.model), modelKey: key, projectTrusted, projectOverride: !!project?.modelOverrides?.[key] || typeof project?.enabled === 'boolean' }), 'info');
      } catch (error) {
        ctx.ui.notify(prefix + JSON.stringify({ ok: false, error: String(error.message || error) }), 'info');
      }
    },
  });
  const token = process.env.PI_DESKTOP_BRIDGE_TOKEN;
  if (!token) return;
  pi.registerTool({
    name: 'desktop_scout',
    label: 'Default 探子',
    description: '派发只读探索、跨文件检索和独立核验给 default 探子。每项任务使用独立上下文，只提供 read/grep/find/ls。任务会出现在 Pi Desktop 子代理工作台，可查看输出、取消和恢复。主代理负责代码修改和最终验证。最多一次 8 项、4 项并行。请给出自包含的目标、范围和所需出处。',
    parameters: Type.Object({ tasks: Type.Array(Type.String({ minLength: 1, maxLength: 32768 }), { minItems: 1, maxItems: 8 }), model: Type.Optional(Type.String({ description: '可选 provider/modelId；省略时跟随主模型。' })) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const request = async (payload, cancellable = true) => {
        const value = await ctx.ui.input('PI_DESKTOP_AGENT_RPC', JSON.stringify({ token, ...payload }), cancellable ? { signal } : undefined);
        if (!value) throw new Error('桌面任务管理器未响应');
        const result = JSON.parse(value);
        if (!result.ok) throw new Error(result.error || '桌面任务操作失败');
        return result.data;
      };
      if (signal?.aborted) throw new Error('父任务已取消');
      const created = await request({ action: 'start', tasks: params.tasks, owner: _id, ...(params.model ? { model: params.model } : {}) });
      const ids = created.tasks.map(task => task.id);
      let finished = false;
      try {
        while (!signal?.aborted) {
          const tasks = await Promise.all(ids.map(id => request({ action: 'detail', id })));
          const active = tasks.filter(task => ['queued', 'starting', 'running', 'cancelling'].includes(task.status));
          onUpdate?.({ content: [{ type: 'text', text: tasks.map(task => `${task.agent} · ${task.status} · ${task.task.slice(0, 100)}`).join('\n') }], details: { taskIds: ids } });
          if (!active.length) {
            finished = true;
            return { content: [{ type: 'text', text: tasks.map(task => `## ${task.agent} · ${task.status}\n任务：${task.task}\n${task.error ? `错误：${task.error}\n` : ''}${(task.output || '').slice(0, 16000)}${task.output?.length > 16000 ? '\n[完整结果保存在子代理工作台]' : ''}`).join('\n\n') }], details: { taskIds: ids } };
          }
          await new Promise(resolve => setTimeout(resolve, 350));
        }
        throw new Error('子代理任务已取消');
      } finally {
        if (!finished) await Promise.all(ids.map(id => request({ action: 'cancel', id }, false).catch(() => {})));
      }
    },
  });
}
