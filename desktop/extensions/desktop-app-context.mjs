// Supplies temporary model input through the desktop's authenticated Pi channel.
export default function desktopAppContext(pi, token = process.env.PI_DESKTOP_BRIDGE_TOKEN) {
  if (!token) return;
  pi.on('context', async (event, ctx) => {
    if (!ctx.hasUI) return;
    try {
      const raw = await ctx.ui.input('PI_DESKTOP_APP_CONTEXT', JSON.stringify({
        token, sessionId:ctx.sessionManager.getSessionId(),
      }), {signal:AbortSignal.timeout(5000)});
      if (!raw) return;
      const result = JSON.parse(raw);
      if (!Array.isArray(result.contexts)) return;
      const messages = result.contexts.map(context => {
        const parts = (context.content || []).map(block => block.text);
        if (context.structuredContent !== undefined) parts.push(JSON.stringify(context.structuredContent));
        return {role:'user',timestamp:context.timestamp,content:[{type:'text',
          text:`[MCP App context ${context.source} · ${context.id}]\n${parts.join('\n')}`}]};
      });
      if (messages.length) return {messages:[...event.messages,...messages]};
    } catch { /* A cancelled desktop query leaves Pi's current input available. */ }
  });
}
