import desktopModelPolicy, { fastState, fastChoices, pendingEdit } from '../extensions/desktop-model-policy.mjs';
import desktopPermissions from '../extensions/desktop-permissions.mjs';
// Deterministic Pi protocol fixture. Never makes a model or network request.
import { JsonLines } from '../electron/rpc.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const args = process.argv.slice(2);
const noSession = args.includes('--no-session');
const forked = args.includes('--fork') ? args[args.indexOf('--fork') + 1] : null;
const restored = args.includes('--session') ? args[args.indexOf('--session') + 1] : forked;
const config = process.env.PI_CODING_AGENT_DIR || path.join(process.cwd(), '.fixture-agent');
const cwd = process.cwd();
const sessionDir = args.includes('--session-dir') ? args[args.indexOf('--session-dir') + 1] : path.join(config, 'sessions', '--fixture--');
const bridgePath = args.includes('-e') ? args[args.indexOf('-e') + 1] : '';
const isScout = !!process.env.PI_DESKTOP_TASK_ID;
let sessionId = randomUUID(), sessionName, entries = [], leafId = null, active = false, timers = [], pendingConfirm, messageIndex = 0;
let compacting = false, compactCommand, contextTokens = 1200;
const settings = () => {
  const read = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const global = read(path.join(config, 'settings.json')).compaction || {};
  const projectTrusted = args.includes('--approve');
  const project = projectTrusted ? read(path.join(cwd, '.pi/settings.json')).compaction || {} : {};
  const modelKey = `${model.provider}/${model.id}`;
  const override = { ...global.modelOverrides?.[modelKey], ...project.modelOverrides?.[modelKey] };
  return { ok: true, fastMode: fastState(policyContext()), modelKey, enabled: project.enabled ?? global.enabled ?? true, reserveTokens: override.reserveTokens ?? project.reserveTokens ?? global.reserveTokens ?? 16384, keepRecentTokens: override.keepRecentTokens ?? project.keepRecentTokens ?? global.keepRecentTokens ?? 20000, projectTrusted, projectOverride: !!project.modelOverrides?.[modelKey] || typeof project.enabled === 'boolean' };
};
const queue = { steering: [], followUp: [] };
const models = [
  { id: 'fixture-model', name: '测试模型', provider: 'fixture', api: 'openai-responses', reasoning: true, input: ['text', 'image'], contextWindow: 200000 },
  { id: 'fixture-fast', name: '快速模型', provider: 'fixture', api: 'anthropic-messages', reasoning: false, input: ['text'], contextWindow: 64000 },
];
let model = models[0], thinkingLevel = 'medium';
let sessionFile = noSession ? undefined : (!forked && restored) || path.join(sessionDir, `${sessionId}.jsonl`);
mkdirSync(sessionDir, { recursive: true });
if (restored) {
  const records = readFileSync(restored, 'utf8').trim().split('\n').map(JSON.parse);
  if (!forked) sessionId = records[0].id; entries = records.slice(1); leafId = entries.at(-1)?.id || null;
  sessionName = entries.filter(e => e.type === 'session_info').at(-1)?.name;
}
const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
const respond = (command, data) => emit({ type: 'response', command: command.type, id: command.id, success: true, data });
const persist = () => {
  if (!sessionFile) return;
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, [{ type: 'session', version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() }, ...entries].map(item => JSON.stringify(item)).join('\n') + '\n');
};
if (forked) persist();
const append = entry => { const next = { ...entry, id: randomUUID(), parentId: leafId, timestamp: new Date().toISOString() }; entries.push(next); leafId = next.id; persist(); };
const message = (role, content, extra = {}) => ({ role, content, timestamp: Date.now() + messageIndex++, ...extra });
const completeMessage = m => { emit({ type: 'message_start', message: m }); emit({ type: 'message_end', message: m }); append({ type: 'message', message: m }); };
const later = (fn, delay) => timers.push(setTimeout(fn, delay));
const start = command => {
  active = true;
  emit({ type: 'agent_start' });
  completeMessage(message('user', command.images?.length ? [{ type: 'text', text: command.message }, ...command.images] : command.message));
  respond(command, { disposition: 'started' });
  const assistant = message('assistant', [], { model: model.id, provider: model.provider, stopReason: 'pending' });
  emit({ type: 'message_start', message: assistant });
  later(() => emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '先检查工作区。' } }), 50);
  later(() => emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '正在查看项目。\u2028中文流式输出。' } }), 150);
  const toolCall = { type: 'toolCall', id: randomUUID(), name: 'read', arguments: { path: 'README.md' } };
  later(() => {
    assistant.content = [{ type: 'thinking', thinking: '先检查工作区。' }, { type: 'text', text: '正在查看项目。\u2028中文流式输出。' }, toolCall]; assistant.stopReason = 'toolUse';
    emit({ type: 'message_end', message: assistant }); append({ type: 'message', message: assistant });
    emit({ type: 'tool_execution_start', toolCallId: toolCall.id, toolName: 'read', args: toolCall.arguments });
  }, 250);
  later(() => {
    const result = { content: [{ type: 'text', text: '# 测试项目\n这是工具输出。' }] };
    emit({ type: 'tool_execution_end', toolCallId: toolCall.id, toolName: 'read', result, isError: false, durationMs: 27 });
    completeMessage(message('toolResult', result.content, { toolCallId: toolCall.id, toolName: 'read', isError: false }));
    const failed = isScout && command.message.includes('[fixture-fail-agent]');
    completeMessage(message('assistant', [{ type: 'text', text: failed ? '探子测试错误' : isScout && command.message.includes('[fixture-long-agent]') ? '中文🙂'.repeat(20000) + 'RESULT_END' : '已完成检查。\n\n- 工作区连接正常\n- 工具结果已收到\n\n```ts\nconst ready = true;\n```\n\n[不安全链接](javascript:alert(1))\n<img src="x" onerror="alert(1)">' }], { model: model.id, provider: model.provider, stopReason: failed ? 'error' : 'stop', ...(failed ? { errorMessage: 'fixture provider failed' } : {}), usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 0, totalTokens: 150, cost: { total: .0012 } } }));
    active = false; emit({ type: 'agent_end', willRetry: false });
    const next = queue.steering.shift() || queue.followUp.shift();
    emit({ type: 'queue_update', ...queue });
    if (next) start({ type: 'prompt', message: next, id: 'queued' }); else emit({ type: 'agent_settled', aborted: false });
  }, command.message.includes('等待') ? 8000 : 900);
};
let scoutControl;
function askScout(action, payload = {}) {
  const id = randomUUID(); scoutControl.requestId = id;
  emit({ type: 'extension_ui_request', method: 'input', id, title: 'PI_DESKTOP_AGENT_RPC', placeholder: JSON.stringify({ token: process.env.PI_DESKTOP_BRIDGE_TOKEN, action, ...payload }) });
}
let permissionHook, permissionWait;
const appContextQueries = new Map();
desktopPermissions({ registerCommand(){}, on(name,handler){ if(name==='tool_call')permissionHook=handler; } });
async function permissionTool(command) {
  active=true;emit({type:'agent_start'});completeMessage(message('user',command.message));respond(command,{disposition:'started'});
  const toolCallId=randomUUID();const toolName=command.message.includes('[child-permission]')?'bash':'write';
  const input=toolName==='bash'?{command:'echo permission-check'}:{path:'approved.txt',content:'PI_PERMISSION_OK'};
  emit({type:'tool_execution_start',toolCallId,toolName,args:input});
  const blocked=await permissionHook({toolName,toolCallId,input},{cwd,hasUI:true,ui:{input:async(title,placeholder)=>new Promise(resolve=>{
    const id=randomUUID();permissionWait={id,resolve};emit({type:'extension_ui_request',method:'input',id,title,placeholder});
  })}});
  const allowed=!blocked?.block;
  if(allowed&&toolName==='write')writeFileSync(path.join(cwd,'approved.txt'),'PI_PERMISSION_OK');
  emit({type:'tool_execution_end',toolCallId,toolName,isError:!allowed,result:{content:[{type:'text',text:allowed?'PERMISSION_ALLOWED':'PERMISSION_DENIED'}]}});
  completeMessage(message('assistant',[{type:'text',text:allowed?'PERMISSION_ALLOWED':'PERMISSION_DENIED'}],{model:model.id,provider:model.provider,stopReason:'stop'}));
  active=false;emit({type:'agent_end',willRetry:false});emit({type:'agent_settled',aborted:false});
}
const activeEntries = () => {
  const byId=new Map(entries.map(entry=>[entry.id,entry])), branch=[],seen=new Set();
  let id=leafId;
  while(id&&!seen.has(id)){seen.add(id);const entry=byId.get(id);if(!entry)break;branch.push(entry);id=entry.parentId;}
  return branch.reverse();
};
const policyContext = () => ({ model, isIdle: () => !active && !compacting, hasPendingMessages: () => !!(queue.steering.length + queue.followUp.length), sessionManager: { getSessionId: () => sessionId, getBranch: activeEntries } });
const policy = desktopModelPolicy({ on() {}, appendEntry: (customType, data) => append({ type: 'custom', customType, data }) });
const handle = command => {
  switch (command.type) {
    case 'get_desktop_app_context': {
      const id=randomUUID();
      appContextQueries.set(id,command);
      emit({type:'extension_ui_request',method:'input',id,title:'PI_DESKTOP_APP_CONTEXT',
        placeholder:JSON.stringify({token:command.token ?? process.env.PI_DESKTOP_BRIDGE_TOKEN,
          sessionId:command.sessionId ?? sessionId})});
      return;
    }
    case 'get_state': {
      const state = { model, thinkingLevel, isStreaming: active, isCompacting: compacting, autoCompactionEnabled: settings().enabled, sessionFile, sessionId, sessionName, messageCount: entries.length, pendingMessageCount: queue.steering.length + queue.followUp.length };
      if (scoutControl?.slow && !scoutControl.taskId) return later(() => respond(command, state), 500);
      return respond(command, state);
    }
    case 'get_entries': return respond(command, { entries, leafId });
    case 'get_fork_messages': return respond(command,{messages:activeEntries().filter(entry=>entry.type==='message'&&entry.message.role==='user').map(entry=>({entryId:entry.id,text:typeof entry.message.content==='string'?entry.message.content:entry.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')}))});
    case 'fork': {
      const branch=activeEntries(), index=branch.findIndex(entry=>entry.id===command.entryId&&entry.type==='message'&&entry.message.role==='user');
      if(index<0)return emit({type:'response',command:command.type,id:command.id,success:false,error:'fork target is not active'});
      const target=branch[index].message;
      const text=typeof target.content==='string'?target.content:target.content.filter(block=>block.type==='text').map(block=>block.text).join('\n');
      if(text.includes('[fork-cancel]'))return respond(command,{cancelled:true});
      entries=branch.slice(0,index);leafId=entries.at(-1)?.id||null;sessionId=randomUUID();sessionFile=path.join(sessionDir,sessionId+'.jsonl');persist();
      return respond(command,{cancelled:false,text});
    }

    case 'get_messages': return respond(command, { messages: entries.filter(e => e.type === 'message').map(e => e.message) });
    case 'get_available_models': return respond(command, { models });
    case 'get_available_thinking_levels': return respond(command, { levels: model.reasoning ? ['off', 'low', 'medium', 'high'] : ['off'] });
    case 'get_commands': return respond(command, { commands: [{ name: 'mcp', source: 'extension', sourceInfo: { path: 'builtin:mcp' }, description: 'Manage MCP servers' }, ...(bridgePath ? [{ name: 'desktop-permissions', source: 'extension', sourceInfo: { path: bridgePath }, description: 'Desktop permissions' }, { name: 'desktop-context', source: 'extension', sourceInfo: { path: bridgePath }, description: 'Desktop context' }] : []), { name: 'confirm-test', source: 'extension', description: '测试扩展确认框' }, { name: 'skill:review', source: 'skill', description: '审查代码' }] });
    case 'get_session_stats': {
      const usages = entries.filter(entry => entry.type === 'message' && entry.message.usage).map(entry => entry.message.usage);
      const total = key => usages.reduce((sum, usage) => sum + (usage[key] || 0), 0);
      return respond(command, { cost: usages.reduce((sum, usage) => sum + (usage.cost?.total || 0), 0), tokens: { input: total('input'), output: total('output'), cacheRead: total('cacheRead'), cacheWrite: total('cacheWrite'), total: total('totalTokens') }, contextUsage: { tokens: contextTokens, contextWindow: model.contextWindow, percent: contextTokens / model.contextWindow * 100 } });
    }
    case 'prompt': {
      if(command.message==='/metrics-test') {
        active=true;emit({type:'agent_start'});completeMessage(message('user','模型统计测试'));respond(command,{disposition:'started'});
        const reply=message('assistant',[],{model:model.id,provider:model.provider,stopReason:'pending'});
        emit({type:'message_start',message:reply});
        later(()=>emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'模型统计已更新。'}}),80);
        later(()=>{reply.content=[{type:'text',text:'模型统计已更新。'}];reply.stopReason='stop';reply.usage={input:100,output:40,cost:{total:.0123}};emit({type:'message_end',message:reply});append({type:'message',message:reply});active=false;emit({type:'agent_end',willRetry:false});emit({type:'agent_settled',aborted:false});},400);
        return;
      }
      if(command.message.includes('[edit-send-fail]'))return emit({type:'response',command:command.type,id:command.id,success:false,error:'EDIT_SEND_REJECTED'});

      if(command.message==='/context-priority-test'){emit({type:'extension_ui_request',method:'notify',id:randomUUID(),notifyType:'info',message:'PI_DESKTOP_USAGE:'+JSON.stringify({usage:{tokens:10,contextWindow:model.contextWindow},modelKey:`${model.provider}/${model.id}`,estimated:true})});return respond(command,{disposition:'handled'});}

      if(command.message==='/permission-write-test'||command.message.includes('[child-permission]')) {void permissionTool(command);return;}

      if (command.message === '/overflow-test') {
        const url = 'https://example.invalid/' + 'long-unbroken-path-'.repeat(36);
        const detail = 'OpenAI API error (524): ' + JSON.stringify({ type: url, detail: 'timeout', token: '界'.repeat(128) });
        completeMessage(message('user', '检查长错误输出'));
        completeMessage(message('assistant', [{ type: 'text', text: `长链接：${url}\n\n\`\`\`text\n${url}\n\`\`\`` }], { model: model.id, errorMessage: detail, stopReason: 'error' }));
        emit({ type: 'extension_ui_request', id: randomUUID(), method: 'notify', notifyType: 'error', message: detail });
        emit({ type: 'agent_settled', aborted: false });
        return respond(command, { disposition: 'handled' });
      }
      if (command.message.startsWith('/desktop-context ')) {
        const [, operation, nonce, ...payload] = command.message.split(' ');
        let result = settings();
        if (operation === 'fast') {
          try { result = { ok: true, fastMode: policy.set(policyContext(), JSON.parse(payload.join(' '))) }; }
          catch (error) { result = { ok: false, error: error.message }; }
        }
        if (operation === 'edit') {
          const { sessionId: expected, entryId } = JSON.parse(payload.join(' '));
          const target = activeEntries().find(entry => entry.id === entryId && entry.type === 'message' && entry.message.role === 'user');
          const leaf = pendingEdit(activeEntries());
          const prepared = leaf?.data?.entryId === entryId;
          if (expected !== sessionId || (!target && !prepared) || active || compacting) result = { ok: false, error: 'Invalid edit target or busy session' };
          else if (prepared) result = { ok: true, cancelled: false };
          else if (JSON.stringify(target.message.content).includes('[edit-cancel]')) result = { ok: true, cancelled: true };
          else {
            const fastModes = fastChoices(activeEntries());
            leafId = target.parentId;
            append({ type: 'custom', customType: 'desktop-message-edit', data: { entryId, fastModes } });
            result = { ok: true, cancelled: false };
          }
        }
        emit({ type: 'extension_ui_request', method: 'notify', id: randomUUID(), notifyType: 'info', message: `PI_DESKTOP_CONTEXT:${nonce}:${JSON.stringify(result)}` });
        return respond(command, { disposition: 'handled', operation });
      }
      if (['/desktop-scout-test', '/desktop-scout-slow-test'].includes(command.message)) {
        active = true; emit({ type: 'agent_start' }); completeMessage(message('user', command.message));
        const callId = randomUUID(); scoutControl = { command, callId, slow: command.message === '/desktop-scout-slow-test' };
        completeMessage(message('assistant', [{ type: 'toolCall', id: callId, name: 'desktop_scout', arguments: { tasks: ['自动派发的只读检查'] } }]));
        emit({ type: 'tool_execution_start', toolCallId: callId, toolName: 'desktop_scout', args: { tasks: ['自动派发的只读检查'] } });
        return askScout('start', { tasks: [scoutControl.slow ? '等待自动派发的只读检查' : '自动派发的只读检查'], model: 'fixture/fixture-model', owner: callId });
      }
      if (command.message === '/crash-test') { respond(command,{disposition:'handled'}); process.exit(9); }
      if (command.message.startsWith('/mcp')) {
        emit({type:'extension_ui_request',method:'notify',id:randomUUID(),notifyType:'info',message:'fixture: connected, 3 tools (deferred)\nbroken: failed (direct)\n    connection refused'});
        return respond(command,{disposition:'handled'});
      }
      if (command.message === '/confirm-test') {
        pendingConfirm = command;
        return emit({ type: 'extension_ui_request', id: 'confirm-dialog', method: 'confirm', title: '是否继续测试？', message: '这是可控测试，不会执行外部操作。' });
      }
      if (active) {
        queue[command.streamingBehavior === 'followUp' ? 'followUp' : 'steering'].push(command.message);
        emit({ type: 'queue_update', ...queue }); return respond(command, { disposition: 'queued' });
      }
      return start(command);
    }
    case 'extension_ui_response':
      if (appContextQueries.has(command.id)) {
        const query=appContextQueries.get(command.id);
        appContextQueries.delete(command.id);
        respond(query,command.cancelled ? {contexts:[],cancelled:true} : JSON.parse(command.value));
        return;
      }
      if(permissionWait?.id===command.id){const pending=permissionWait;permissionWait=null;pending.resolve(command.cancelled?undefined:command.value);return;}

      if (scoutControl?.requestId === command.id) {
        const response = JSON.parse(command.value);
        if (!response.ok) { const original=scoutControl.command; scoutControl=null; active=false; emit({type:'agent_settled',aborted:true}); return respond(original,{disposition:'handled'}); }
        if (!scoutControl.taskId) { scoutControl.taskId = response.data.tasks[0].id; return askScout('detail', { id: scoutControl.taskId }); }
        const task = response.data;
        if (['queued', 'starting', 'running', 'cancelling'].includes(task.status)) return later(() => askScout('detail', { id: scoutControl.taskId }), 100);
        const result = { content: [{ type: 'text', text: task.output }], details: { taskIds: [task.id] } };
        emit({ type: 'tool_execution_end', toolCallId: scoutControl.callId, toolName: 'desktop_scout', result, isError: false });
        completeMessage(message('toolResult', result.content, { toolCallId: scoutControl.callId, toolName: 'desktop_scout', isError: false }));
        completeMessage(message('assistant', [{ type: 'text', text: '探子已返回，主 Agent 可以汇总。' }]));
        active = false; emit({ type: 'agent_settled', aborted: false }); respond(scoutControl.command, { disposition: 'started' }); scoutControl = null; return;
      }
      if (pendingConfirm) { emit({ type: 'extension_ui_request', id: 'notify-1', method: 'notify', message: command.confirmed ? '已收到确认' : '已取消确认' }); respond(pendingConfirm, { disposition: 'handled' }); pendingConfirm = null; }
      return;
    case 'clear_queue': { const previous = { steering: [...queue.steering], followUp: [...queue.followUp] }; queue.steering = []; queue.followUp = []; emit({ type: 'queue_update', ...queue }); return respond(command, previous); }
    case 'abort':
      timers.forEach(clearTimeout); timers = []; active = false;
      if(permissionWait){const pending=permissionWait;permissionWait=null;pending.resolve(undefined);}

      if (scoutControl) { const original=scoutControl.command; const callId=scoutControl.callId; scoutControl=null; emit({type:'tool_execution_end',toolCallId:callId,toolName:'desktop_scout',isError:true,result:{content:[{type:'text',text:'父任务已取消'}]}});respond(original,{disposition:'handled'}); }
      if (compacting) { compacting = false; emit({ type: 'compaction_end', reason: 'manual', aborted: true }); emit({ type: 'response', id: compactCommand.id, command: 'compact', success: false, error: '压缩已取消' }); compactCommand = null; }
      emit({ type: 'agent_settled', aborted: true }); return respond(command);
    case 'set_model': model = models.find(m => m.id === command.modelId) || models[0]; if (!model.reasoning) thinkingLevel = 'off'; return respond(command, model);
    case 'set_thinking_level': thinkingLevel = command.level; return respond(command);
    case 'set_session_name': sessionName = command.name; append({ type: 'session_info', name: sessionName }); emit({ type: 'session_info_changed', name: sessionName }); return respond(command);
    case 'compact': {
      compacting = true; compactCommand = command; emit({ type: 'compaction_start', reason: 'manual' });
      return later(() => {
        compacting = false; compactCommand = null;
        if (command.customInstructions?.includes('[fixture-fail]')) { emit({ type: 'compaction_end', reason: 'manual', errorMessage: 'fixture compaction failed' }); return emit({ type: 'response', id: command.id, command: 'compact', success: false, error: 'fixture compaction failed' }); }
        const result = { summary: '已压缩测试上下文', tokensBefore: contextTokens, estimatedTokensAfter: 400, firstKeptEntryId: leafId, usage: { input: 80, output: 20, cost: { total: .0005 } } };
        contextTokens = 400; append({ type: 'compaction', ...result }); emit({ type: 'compaction_end', reason: 'manual', result }); respond(command, result);
      }, command.customInstructions?.includes('[fixture-slow]') ? 5000 : 220);
    }
    case 'export_html': writeFileSync(command.outputPath, '<html><body>Fixture export</body></html>'); return respond(command, { path: command.outputPath });
    case 'echo': return later(() => respond(command, { value: command.value }), command.delay);
    case 'hang': return;
    default: emit({ type: 'response', id: command.id, command: command.type, success: false, error: 'Unknown command' });
  }
};
const parser = new JsonLines(handle);
process.stdin.on('data', chunk => parser.push(chunk));
process.stdin.on('end', () => { timers.forEach(clearTimeout); process.exit(0); });
