// Pi's tool-call approval gate. This is an approval policy, not an OS sandbox.
export default function desktopPermissions(pi) {
  const token = process.env.PI_DESKTOP_PERMISSION_TOKEN;
  pi.registerCommand('desktop-permissions', {
    description: '读取桌面工具授权策略',
    handler: async (args, ctx) => {
      if (!/^[a-f0-9-]{36}$/.test(args.trim())) return;
      try { const value=await ctx.ui.input('PI_DESKTOP_PERMISSION_QUERY',JSON.stringify({token}));const policy=value?JSON.parse(value):null;ctx.ui.notify(`PI_DESKTOP_PERMISSIONS:${args.trim()}:${JSON.stringify(policy)}`, 'info'); }
      catch { ctx.ui.notify(`PI_DESKTOP_PERMISSIONS:${args.trim()}:null`, 'error'); }
    },
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!ctx.hasUI || !token) return { block: true, reason: '无法请求授权，已阻止工具执行' };
    try {
      const answer = await ctx.ui.input('PI_DESKTOP_PERMISSION', JSON.stringify({ token, tool: event.toolName, toolCallId: event.toolCallId, input: event.input }));
      if (answer === 'allow') return;
    } catch { /* A cancelled/closed approval never authorizes a tool. */ }
    return { block: true, reason: '工具操作未获批准' };
  });
}
