import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plug, RefreshCw, Unplug, Zap } from './icons';
import type { Wire } from './types';
import { McpContentPanel } from './McpContentPanel';
import { McpAppLauncher } from './McpAppLauncher';
import {
  callTone,
  defaultArgumentsFor,
  filterTools,
  formatCallResult,
  parseArguments,
  schemaFields,
  serverStateLabel,
  serverTone,
  serverWarnings,
  transportLabel,
} from './mcp.mjs';

// 「MCP 连接」卡片（P1.2）：桌面端自己按 MCP 协议连接服务器，可以列工具并调用。
// Pi 自身的 /mcp 状态仍在原来的「MCP 连接」面板里，这里是桌面侧的结构化视图。
export function McpToolsPanel({ onError }: { onError: (error: unknown) => void }) {
  const [listing, setListing] = useState<Wire>({ servers: [], warnings: [] });
  const [active, setActive] = useState('');
  const [tools, setTools] = useState<Wire[]>([]);
  const [query, setQuery] = useState('');
  const [tool, setTool] = useState<Wire | null>(null);
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<{ isError: boolean; text: string } | null>(null);
  const [appResult, setAppResult] = useState<{arguments: Wire; result: Wire} | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const [capabilities, setCapabilities] = useState<Wire>({});
  const [tab, setTab] = useState('tools');

  const refresh = useCallback(async () => {
    try {
      setListing(await window.pi.mcpServers());
    } catch (error) {
      onError(error);
    }
  }, [onError]);

  useEffect(() => { void refresh(); }, [refresh]);

  const servers: Wire[] = listing.servers || [];
  const visibleTools = useMemo(() => filterTools(tools, query), [tools, query]);

  const connect = useCallback(async (name: string, force = false) => {
    setBusy(name);
    try {
      const connection = await window.pi.mcpConnect(name);
      const caps = connection.server.capabilities || {};
      setActive(name);
      setCapabilities(caps);
      setTab(caps.tools ? 'tools' : caps.resources ? 'resources' : 'prompts');
      setTools([]);
      setTool(null);
      setResult(null);
      setAppResult(null);
      setQuery('');
      setOpen(current => ({ ...current, [name]: true }));
      if (caps.tools) {
        try {
          const data = await window.pi.mcpTools({ name, refresh: force });
          setTools(data.tools || []);
        } catch (error) { onError(error); }
      }
      await refresh();
    } catch (error) {
      onError(error);
      setTools([]);
      setActive('');
    } finally {
      setBusy('');
    }
  }, [onError, refresh]);

  const disconnect = useCallback(async (name: string) => {
    setBusy(name);
    try {
      await window.pi.mcpDisconnect(name);
      if (active === name) {
        setActive('');
        setTools([]);
        setTool(null);
        setResult(null);
        setAppResult(null);
      }
      await refresh();
    } catch (error) {
      onError(error);
    } finally {
      setBusy('');
    }
  }, [active, onError, refresh]);

  const call = useCallback(async () => {
    if (!tool || !active) return;
    const parsed = parseArguments(args);
    if (!parsed.ok) {
      onError(new Error(parsed.error));
      return;
    }
    setBusy('call');
    setAppResult(null);
    try {
      const data = await window.pi.mcpCall({ name: active, tool: tool.name, arguments: parsed.value });
      setResult(formatCallResult(data.result));
      setAppResult({arguments:parsed.value,result:data.result});
    } catch (error) {
      onError(error);
      setResult(null);
    } finally {
      setBusy('');
    }
  }, [active, args, onError, tool]);

  const selectTool = (next: Wire) => {
    setTool(next);
    setArgs(defaultArgumentsFor(next));
    setResult(null);
    setAppResult(null);
  };

  return (
    <section className="update-card mcp-tools-card">
      <div className="update-head">
        <strong>桌面 MCP 调试</strong>
        <span className={`update-chip ${servers.some(server => server.connected) ? 'ok' : 'idle'}`}>
          {servers.filter(server => server.connected).length}/{servers.length} 已连接
        </span>
      </div>
      <p className="setting-help">
        独立连接，不影响 Pi 会话
      </p>
      {listing.path && <details className="diagnostics"><summary>配置位置</summary><code>{listing.path}</code></details>}
      {(listing.warnings || []).length > 0 && (
        <ul className="mcp-warnings">
          {(listing.warnings || []).map((warning: string) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      <div className="settings-actions update-actions">
        <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void refresh()}>
          <RefreshCw size={14} /> 重新读取配置
        </button>
      </div>
      <ul className="extensions-list mcp-servers">
        {servers.map(server => {
          const tone = serverTone(server);
          const connected = server.connected === true && active === server.name;
          return (
            <li key={server.name} className="extension-row mcp-server">
              <div className="extension-head">
                <span className={`update-chip ${tone}`}>{serverStateLabel(server)}</span>
                <strong>{server.name}</strong>
                <span className="extension-version">{transportLabel(server)}{server.toolCount ? ` · ${server.toolCount} 个工具` : ''}</span>
              </div>
              <div className="extension-meta">
                <code>{server.command || server.url || '—'}</code>
                {server.timeout ? <span>超时 {server.timeout}s</span> : null}
                {server.exposure ? <span>暴露方式：{({ direct: '直接暴露', deferred: '按需加载', local: '本地连接' } as Record<string, string>)[server.exposure] || server.exposure}</span> : null}
              </div>
              {serverWarnings(server, listing).map((warning: string) => (
                <p key={warning} className="setting-help extension-error">{warning}</p>
              ))}
              <div className="settings-actions update-actions">
                <button
                  className="secondary-button"
                  disabled={Boolean(busy) || server.transport === 'invalid' || server.enabled === false}
                  onClick={() => void connect(server.name, connected)}
                >
                  <Plug size={14} /> {connected ? '刷新连接' : '连接'}
                </button>
                <button
                  className="secondary-button"
                  disabled={Boolean(busy) || server.connected !== true}
                  onClick={() => void disconnect(server.name)}
                >
                  <Unplug size={14} /> 断开
                </button>
                <button
                  className="secondary-button"
                  disabled={!connected}
                  onClick={() => setOpen(current => ({ ...current, [server.name]: !current[server.name] }))}
                >
                  {open[server.name] ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 浏览能力
                </button>
              </div>
              {connected && open[server.name] && (
                <div className="mcp-tools">
                  <div className="settings-actions" role="group" aria-label="MCP 能力">
                    {[['tools', '工具'], ['resources', '资源'], ['prompts', '提示词']].filter(([key]) => capabilities[key]).map(([key, label]) => (
                      <button key={key} className="secondary-button" aria-pressed={tab === key} disabled={Boolean(busy)} onClick={() => setTab(key)}>{label}</button>
                    ))}
                  </div>
                  {!capabilities.tools && !capabilities.resources && !capabilities.prompts && <p className="setting-help">服务器未声明工具、资源或提示词能力。</p>}
                  {tab !== 'tools' && capabilities[tab] && <McpContentPanel key={`${active}:${tab}`} name={active} kind={tab as 'resources' | 'prompts'} onError={onError} />}
                  {tab === 'tools' && <>
                  <input
                    className="extensions-filter"
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder="按工具名或说明筛选"
                    aria-label="筛选工具"
                  />
                  <ul className="mcp-tool-list">
                    {visibleTools.map((item: Wire) => (
                      <li key={item.name}>
                        <button
                          type="button"
                          className={`mcp-tool ${tool?.name === item.name ? 'selected' : ''}`}
                          disabled={Boolean(busy)}
                          onClick={() => selectTool(item)}
                        >
                          <strong>{item.name}</strong>
                          {(item._meta?.ui?.resourceUri || item._meta?.['ui/resourceUri']) && <span className="update-chip">App 界面</span>}
                          {(item.required || []).length > 0 && <span className="mcp-required">必填：{item.required.join('、')}</span>}
                          {item.description && <small>{item.description}</small>}
                        </button>
                      </li>
                    ))}
                    {visibleTools.length === 0 && <li className="setting-help">没有匹配的工具。</li>}
                  </ul>
                  {tool && (
                    <div className="mcp-call">
                      <div className="mcp-call-head">
                        <Zap size={14} />
                        <strong>{tool.name}</strong>
                        {schemaFields(tool.inputSchema).map(field => (
                          <span key={field.name} className={`permission-chip risk-${field.required ? 'medium' : 'low'}`}>
                            {field.name}: {field.type}
                          </span>
                        ))}
                      </div>
                      <textarea
                        className="mcp-args"
                        value={args}
                        onChange={event => setArgs(event.target.value)}
                        spellCheck={false}
                        rows={4}
                        aria-label="工具参数 JSON"
                      />
                      <div className="settings-actions update-actions">
                        <button className="primary-button" disabled={busy === 'call'} onClick={() => void call()}>
                          调用工具
                        </button>
                        <button className="secondary-button" disabled={busy === 'call'} onClick={() => setArgs(defaultArgumentsFor(tool))}>
                          重置参数
                        </button>
                      </div>
                      {result && (
                        <pre className={`mcp-result ${callTone(result) === 'error' ? 'error' : ''}`}>{result.text}</pre>
                      )}
                      {appResult && (tool._meta?.ui?.resourceUri || tool._meta?.['ui/resourceUri']) && (
                        <McpAppLauncher key={active + ':' + tool.name} name={active} tool={tool}
                          arguments={appResult.arguments} result={appResult.result} onError={onError} />
                      )}
                    </div>
                  )}
                  </>}
                </div>
              )}
            </li>
          );
        })}
        {servers.length === 0 && <li className="setting-help">mcp.json 里还没有服务器。</li>}
      </ul>
    </section>
  );
}
