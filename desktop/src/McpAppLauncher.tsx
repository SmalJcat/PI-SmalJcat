import { useEffect, useRef, useState } from 'react';
import type { Wire } from './types';

export function McpAppLauncher({ name, tool, arguments: args, result, onError }: {
  name: string; tool: Wire; arguments: Wire; result: Wire; onError: (error: unknown) => void;
}) {
  const [prepared, setPrepared] = useState<Wire | null>(null);
  const [grants, setGrants] = useState<string[]>([]);
  const [allowResources, setAllowResources] = useState(false);
  const [allowMessages, setAllowMessages] = useState(false);
  const [allowModelContext, setAllowModelContext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const mounted = useRef(true);
  const session = useRef({id:'',retain:false});
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (session.current.id && !session.current.retain) {
        void window.pi.mcpAppClose(session.current.id).catch(() => {});
      }
    };
  }, []);
  const prepare = async () => {
    setBusy(true);
    try {
      const data = await window.pi.mcpAppPrepare({name,tool:tool.name});
      if (!mounted.current) {
        await window.pi.mcpAppClose(data.id);
        return;
      }
      session.current = {id:data.id,retain:false};
      setGrants([]);
      setAllowResources(false);
      setAllowMessages(false);
      setAllowModelContext(false);
      setPrepared(data);
    } catch (error) { if (mounted.current) onError(error); }
    finally { if (mounted.current) setBusy(false); }
  };
  const open = async () => {
    if (!prepared) return;
    setBusy(true);
    session.current.retain = true;
    try {
      await window.pi.mcpAppOpen({id:prepared.id,grantedTools:grants,allowResources,allowMessages,allowModelContext,arguments:args,result});
      if (mounted.current) setOpened(true);
    } catch (error) {
      session.current.retain = false;
      if (mounted.current) onError(error);
      else void window.pi.mcpAppClose(prepared.id).catch(() => {});
    } finally { if (mounted.current) setBusy(false); }
  };
  if (!prepared) return <button className="secondary-button" disabled={busy} onClick={() => void prepare()}>打开 MCP App</button>;
  const domains = Object.values(prepared.domains || {}).flat() as string[];
  return <section className="widget-grants" aria-label="MCP App 授权" data-app-id={prepared.id}>
    <strong>{prepared.server} · {prepared.tool}</strong>
    <p className="setting-help">{prepared.uri}</p>
    {domains.length > 0 && <p className="setting-help">网络来源 {Array.from(new Set(domains)).join('、')}</p>}
    <fieldset className="widget-grant-group" disabled={busy || opened}>
      <legend>允许 App 调用的服务器工具</legend>
      {(prepared.tools || []).map((item: Wire) => <label className="widget-grant" key={item.name}>
        <input type="checkbox" checked={grants.includes(item.name)} onChange={event => {
          setGrants(current => event.target.checked ? [...current,item.name] : current.filter(name => name !== item.name));
        }} />
        <span><code>{item.name}</code><small>{item.description}</small></span>
      </label>)}
    </fieldset>
    <label className="widget-grant">
      <input type="checkbox" checked={allowResources} disabled={busy || opened}
        onChange={event => setAllowResources(event.target.checked)} />
      <span>允许 App 读取此服务器的资源<small>此窗口可请求该服务器提供的任意资源 URI。</small></span>
    </label>
    <p className="setting-help">仅勾选的工具可由此 App 调用。内容由上述服务器提供。</p>
    <label className="widget-grant">
      <input type="checkbox" checked={allowMessages} disabled={busy || opened}
        onChange={event => setAllowMessages(event.target.checked)} />
      <span>允许 App 向此 Pi 对话发送消息<small>绑定打开时的对话，发送会触发 Pi 回复，可能产生模型费用。</small></span>
    </label>
    <label className="widget-grant">
      <input type="checkbox" checked={allowModelContext} disabled={busy || opened}
        onChange={event => setAllowModelContext(event.target.checked)} />
      <span>允许 App 为此 Pi 对话提供模型上下文<small>保存最近一次更新，供后续模型请求使用，可能增加用量。</small></span>
    </label>
    <div className="settings-actions">
      <button className="primary-button" disabled={busy || opened} onClick={() => void open()}>
        {opened ? 'App 已打开' : '打开独立窗口'}
      </button>
      <button className="secondary-button" disabled={busy} onClick={() => {
        void window.pi.mcpAppClose(prepared.id).catch(onError);
        session.current = {id:'',retain:false};
        setPrepared(null); setOpened(false);
      }}>关闭 App</button>
    </div>
  </section>;
}
