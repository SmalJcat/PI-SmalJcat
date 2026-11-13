// The resource protocol has a different origin from the trusted native window.
export function mountMcpApp(root, config, resourceUrl, rpc, close) {
  root.replaceChildren();
  root.style.cssText = 'height:100vh;box-sizing:border-box;padding:12px;display:flex;flex-direction:column;gap:8px';
  const header = document.createElement('header');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';
  const heading = document.createElement('h1');
  heading.textContent = String(config.title);
  heading.style.cssText = 'margin:0;font-size:16px';
  const source = document.createElement('p');
  source.textContent = String(config.server) + ' · ' + String(config.uri);
  source.style.cssText = 'margin:0;overflow-wrap:anywhere;opacity:.75';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = '正在加载 App';
  status.style.cssText = 'margin:0;font-size:12px';
  const closeButton = document.createElement('button');
  closeButton.textContent = '关闭 App';
  closeButton.style.cssText = 'font:inherit;padding:6px 10px;border:1px solid GrayText;border-radius:6px;cursor:pointer';
  closeButton.onclick = () => { Promise.resolve(close()).catch(error => { status.textContent = String(error); }); };
  const frame = document.createElement('iframe');
  frame.title = 'MCP App';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.style.cssText = 'width:100%;flex:1;min-height:0;border:0;background:white';
  let disposed = false;
  let closing = false;
  let teardown;
  let ready = false;
  const queuedNotifications = [];
  let finishTeardown;
  const send = message => frame.contentWindow?.postMessage(message, '*');
  const notify = message => {
    if (disposed || closing || message?.jsonrpc!=='2.0' || message.id!==undefined
      || !['notifications/resources/updated','notifications/resources/list_changed'].includes(message.method)) return;
    if (ready) send(message);
    else {
      if (queuedNotifications.length>=128) queuedNotifications.shift();
      queuedNotifications.push(message);
    }
  };
  const receive = async event => {
    if (disposed || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.id === 'host-teardown' && !message.method) {
      finishTeardown?.();
      return;
    }
    if (closing) return;
    let raw;
    try { raw = JSON.stringify(message); } catch { return; }
    if (new TextEncoder().encode(raw).length > 64 * 1024) {
      if (message.id !== undefined) send({jsonrpc:'2.0',id:message.id,error:{code:-32600,message:'App 消息超过 64 KiB'}});
      return;
    }
    try {
      const envelope = await rpc(raw);
      if (disposed || closing) return;
      if (message.method === 'ui/initialize' && envelope.response?.result?.hostContext) {
        envelope.response.result.hostContext.containerDimensions = {width:frame.clientWidth,height:frame.clientHeight};
      }
      if (envelope.response) send(envelope.response);
      for (const notification of envelope.notifications || []) send(notification);
      if (message.method === 'ui/notifications/initialized' && envelope.notifications?.length) {
        ready = true;
        status.textContent = 'App 已就绪';
        for (const notification of queuedNotifications.splice(0)) send(notification);
      }
    } catch (error) {
      if (disposed || closing) return;
      status.textContent = String(error);
      if (message.id !== undefined) send({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:String(error)}});
    }
  };
  window.addEventListener('message', receive);
  const resize = () => {
    if (ready && !disposed && !closing) send({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',
      params:{containerDimensions:{width:frame.clientWidth,height:frame.clientHeight}}});
  };
  window.addEventListener('resize', resize);
  header.append(heading, closeButton);
  frame.src = resourceUrl;
  root.append(header, source, status, frame);
  return {
    frame,
    notify,
    async listenNotifications(poll) {
      while (!disposed && !closing) {
        try {
          const result=await poll();
          if (result.closed) return;
          for (const message of result.notifications || []) notify(message);
        } catch {
          if (!disposed && !closing) await new Promise(resolve=>setTimeout(resolve,500));
        }
      }
    },
    dispose() {
      if (teardown) return teardown;
      closing = true;
      teardown = (async () => {
        if (ready) await new Promise(resolve => {
          const timeout = setTimeout(resolve, 150);
          finishTeardown = () => { clearTimeout(timeout); resolve(); };
          send({jsonrpc:'2.0',id:'host-teardown',method:'ui/resource-teardown',params:{}});
        });
        disposed = true;
        queuedNotifications.length=0;
        window.removeEventListener('message', receive);
        window.removeEventListener('resize', resize);
        frame.remove();
      })();
      return teardown;
    },
  };
}
