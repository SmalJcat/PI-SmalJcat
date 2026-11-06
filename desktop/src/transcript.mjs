export const emptyTranscript = () => ({ messages: [], active: {}, tools: {}, running: false, sequence: 0 });
export function loadTranscript(messages, running = false) {
  const tools = {};
  const rows = messages.map((message, index) => {
    if (message.role === 'toolResult') tools[message.toolCallId] = { name: message.toolName, result: message, status: message.isError ? 'error' : 'done' };
    return { ...message, _key: `history-${index}` };
  });
  return { messages: rows, active: {}, tools, running, sequence: rows.length };
}
export function reduceTranscript(state, event) {
  if (event.type === 'agent_start') return { ...state, running: true };
  if (event.type === 'compaction_start') return { ...state, running: true };
  // agent_end does NOT imply idle: retries and queued work can follow.
  if (event.type === 'agent_settled' || event.type === 'transport_exit') return { ...state, running: false, active: {} };
  if (event.type === 'message_start' || event.type === 'message_end') {
    const message = event.message;
    const slot = message.role === 'toolResult' ? `tool:${message.toolCallId}` : message.role;
    const active = { ...state.active };
    const previous = active[slot];
    const key = previous || `live-${state.sequence}`;
    const row = { ...message, _key: key };
    const messages = previous ? state.messages.map(m => m._key === key ? row : m) : [...state.messages, row];
    if (event.type === 'message_start') active[slot] = key; else delete active[slot];
    let tools = state.tools;
    if (message.role === 'toolResult') tools = { ...tools, [message.toolCallId]: { ...tools[message.toolCallId], name: message.toolName, result: message, status: message.isError ? 'error' : 'done' } };
    return { ...state, active, messages, tools, sequence: state.sequence + (previous ? 0 : 1) };
  }
  if (event.type === 'message_update') {
    const key = state.active.assistant;
    if (!key) return state;
    const update = event.assistantMessageEvent;
    const index = update.contentIndex;
    if (typeof index !== 'number') return state;
    const messages = state.messages.map(message => {
      if (message._key !== key) return message;
      const content = Array.isArray(message.content) ? [...message.content] : [];
      const block = content[index];
      if (update.type.startsWith('text_')) content[index] = { type: 'text', text: update.type === 'text_end' ? update.content : (block?.text || '') + (update.delta || '') };
      else if (update.type.startsWith('thinking_')) content[index] = { type: 'thinking', thinking: update.type === 'thinking_end' ? update.content : (block?.thinking || '') + (update.delta || '') };
      else if (update.type === 'toolcall_start') content[index] = { type: 'toolCall', id: update.id, name: update.toolName, arguments: {} };
      else if (update.type === 'toolcall_end') content[index] = update.toolCall;
      return { ...message, content, usage: event.usage || message.usage };
    });
    return { ...state, messages };
  }
  if (event.type.startsWith('tool_execution_')) {
    const previous = state.tools[event.toolCallId] || {};
    const tool = { ...previous, name: event.toolName, args: event.args || previous.args };
    if (event.type === 'tool_execution_start') tool.status = 'running';
    if (event.type === 'tool_execution_update') tool.result = event.partialResult;
    if (event.type === 'tool_execution_end') { tool.result = event.result; tool.status = event.isError ? 'error' : 'done'; tool.durationMs = event.durationMs; }
    return { ...state, tools: { ...state.tools, [event.toolCallId]: tool } };
  }
  return state;
}
export function textContent(content) {
  return typeof content === 'string' ? content : (content || []).filter(block => block?.type === 'text').map(block => block.text).join('\n');
}
