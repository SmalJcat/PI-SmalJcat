import { useEffect, useRef, useState } from 'react';
import type { Wire } from './types';
import { defaultPromptArguments, formatPromptResult, formatResourceResult, parsePromptArguments } from './mcp-content.mjs';

type Catalog = 'resources' | 'templates' | 'prompts';
const labels: Record<Catalog, string> = { resources: '资源', templates: '资源模板', prompts: '提示词' };

export function McpContentPanel({ name, kind, onError }: { name: string; kind: 'resources' | 'prompts'; onError: (error: unknown) => void }) {
  const [catalog, setCatalog] = useState<Catalog>(kind);
  const [items, setItems] = useState<Wire[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<Wire | null>(null);
  const [uri, setUri] = useState('');
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const revision = useRef(0);
  const consumedCursors = useRef(new Set<string>());
  const reportError = useRef(onError);
  reportError.current = onError;
  useEffect(() => { alive.current = true; return () => { alive.current = false; revision.current++; }; }, []);

  const fail = (reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
    reportError.current(reason);
  };
  const load = async (type: Catalog, next?: string) => {
    const request = ++revision.current;
    setBusy(true); setError('');
    if (next === undefined) {
      setItems([]); setCursor(undefined); setSelected(null); setResult(''); setUri('');
      consumedCursors.current.clear();
    }
    try {
      const options = { name, ...(next === undefined ? {} : { cursor: next }) };
      const data = await (type === 'resources' ? window.pi.mcpResources(options)
        : type === 'templates' ? window.pi.mcpResourceTemplates(options) : window.pi.mcpPrompts(options));
      if (!alive.current || request !== revision.current) return;
      const entries = data[type === 'templates' ? 'resourceTemplates' : type] || [];
      setItems(current => next === undefined ? entries : [...current, ...entries]);
      if (next !== undefined) consumedCursors.current.add(next);
      if (data.nextCursor !== undefined && consumedCursors.current.has(data.nextCursor)) {
        setCursor(undefined);
        setError('服务器返回了重复的分页游标，请刷新目录。');
      } else setCursor(data.nextCursor);
    } catch (reason) {
      if (alive.current && request === revision.current) fail(reason);
    } finally {
      if (alive.current && request === revision.current) setBusy(false);
    }
  };
  useEffect(() => { void load(catalog); }, [name, catalog]);

  const read = async () => {
    let argumentsValue: Record<string, string> = {};
    if (kind === 'prompts') {
      const parsed = parsePromptArguments(args, selected);
      if (!parsed.ok) { setError(parsed.error || '提示词参数无效。'); return; }
      argumentsValue = parsed.value;
    }
    const request = ++revision.current;
    setBusy(true); setError(''); setResult('');
    try {
      const data = kind === 'resources' ? await window.pi.mcpResourceRead({ name, uri })
        : await window.pi.mcpPromptGet({ name, prompt: selected!.name, arguments: argumentsValue });
      if (alive.current && request === revision.current) setResult(kind === 'resources' ? formatResourceResult(data.result) : formatPromptResult(data.result));
    } catch (reason) {
      if (alive.current && request === revision.current) fail(reason);
    } finally {
      if (alive.current && request === revision.current) setBusy(false);
    }
  };

  return <div className="mcp-content-panel" aria-label={`${labels[kind]}浏览`} aria-busy={busy}>
    <div className="settings-actions update-actions">
      {kind === 'resources' && (['resources', 'templates'] as const).map(type => <button key={type} className="secondary-button" disabled={busy} aria-pressed={catalog === type} onClick={() => setCatalog(type)}>{labels[type]}列表</button>)}
      <button className="secondary-button" disabled={busy} onClick={() => void load(catalog)}>刷新{labels[catalog]}</button>
    </div>
    <ul className="mcp-tool-list">
      {items.map((item, index) => <li key={`${item.uri || item.uriTemplate || item.name}:${index}`}>
        <button className={`mcp-tool ${selected === item ? 'selected' : ''}`} disabled={busy} onClick={() => {
          setSelected(item); setResult(''); setError('');
          if (kind === 'resources') setUri(item.uri || '');
          else setArgs(defaultPromptArguments(item));
        }}>
          <strong>{item.title || item.name || item.uri || item.uriTemplate}</strong>
          {(item.uri || item.uriTemplate) && <small>{item.uri || item.uriTemplate}</small>}
          {item.description && <small>{item.description}</small>}
        </button>
      </li>)}
      {!busy && items.length === 0 && !error && <li className="setting-help">没有可列出的{labels[catalog]}。</li>}
    </ul>
    {cursor !== undefined && <button className="secondary-button" disabled={busy} onClick={() => void load(catalog, cursor)}>加载更多{labels[catalog]}</button>}
    {kind === 'resources' ? <div className="mcp-call">
      {selected?.uriTemplate && <p className="setting-help">模板：<code>{selected.uriTemplate}</code>；请填写具体资源 URI。</p>}
      <input className="extensions-filter" aria-label="资源 URI" value={uri} disabled={busy} placeholder="输入资源 URI" onChange={event => { setUri(event.target.value); setResult(''); }} />
      <button className="primary-button" disabled={busy || !uri.trim()} onClick={() => void read()}>读取资源</button>
    </div> : selected && <div className="mcp-call">
      <strong>{selected.title || selected.name}</strong>
      {(selected.arguments || []).map((argument: Wire) => <p className="setting-help" key={argument.name}>{argument.name}{argument.required ? '（必填）' : '（可选）'}{argument.description ? `：${argument.description}` : ''}</p>)}
      <textarea className="mcp-args" aria-label="提示词参数 JSON" rows={4} spellCheck={false} disabled={busy} value={args} onChange={event => { setArgs(event.target.value); setResult(''); }} />
      <button className="primary-button" disabled={busy} onClick={() => void read()}>获取提示词</button>
    </div>}
    {busy && <p className="setting-help" role="status">正在读取…</p>}
    {error && <p className="extension-error" role="alert">{error}</p>}
    {result && <pre className="mcp-result">{result}</pre>}
  </div>;
}
