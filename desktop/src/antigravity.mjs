// Authoritative ACP snapshots and patches have their own revision/session space.
export const emptyAntigravity = () => ({ revision: -1, agentInfo: {}, capabilities: {}, permissionMode: 'ask', permissionRules: {}, permissionConfigError: '', contextUsage: null, connected: false, busy: false, connecting: false, messages: [], tools: {}, configOptions: [], permissions: [], sessionId: '', cwd: '', error: '', warning: '' });
export function applyAntigravity(previous, next) {
  if (!next || !Number.isSafeInteger(next.revision) || next.revision < previous.revision) return previous;
  const reset = next.reset || next.sessionId && previous.sessionId && next.sessionId !== previous.sessionId;
  let messages = next.messages || (reset ? [] : previous.messages);
  let tools = next.tools || (reset ? {} : previous.tools);
  if (next.message?._key) {
    const index = messages.findIndex(message => message._key === next.message._key);
    messages = [...messages];
    if (index < 0) messages.push(next.message); else messages[index] = next.message;
  }
  if (next.toolId && next.tool) tools = { ...tools, [next.toolId]: next.tool };
  const { message, tool, toolId, reset: _reset, ...summary } = next;
  return { ...previous, ...summary, messages, tools };
}
export function acpOptions(option) {
  return (option?.options || []).flatMap(item => item.options ? acpOptions(item) : typeof item.value === 'string' ? [item] : []);
}
export const acpDraftKey = state => `antigravity-draft:${state.cwd}:${state.sessionId || 'new'}`;
