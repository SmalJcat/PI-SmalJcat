import { useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import rust from 'highlight.js/lib/languages/rust';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import { Copy, Check, ArrowUpRight, RefreshCw, Plug, CircleAlert, LoaderCircle } from './icons';
import { Modal, IconButton } from './components';
import type { Preview, Wire } from './types';
for (const [name,language] of Object.entries({javascript,typescript,rust,python,json,css,xml,bash})) hljs.registerLanguage(name,language);
const languageFor=(path:string)=>({ts:'typescript',tsx:'typescript',js:'javascript',jsx:'javascript',mjs:'javascript',rs:'rust',py:'python',json:'json',css:'css',html:'xml',xml:'xml',sh:'bash'}[path.split('.').pop()?.toLowerCase()||'']);
function escaped(text:string){return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
export function highlighted(text:string,language?:string){
  if(!language||!hljs.getLanguage(language)||text.length>300000)return escaped(text);
  try{return hljs.highlight(text,{language,ignoreIllegals:true}).value;}catch{return escaped(text);}
}
export function CodeBlock({text,language}:{text:string;language?:string}){
  const [copied,setCopied]=useState(false);
  const html=useMemo(()=>highlighted(text,language),[text,language]);
  return <div className="code-block"><div className="code-toolbar"><span>{language||'code'}</span><button onClick={()=>void navigator.clipboard.writeText(text).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1500);})}>{copied?<Check size={13}/>:<Copy size={13}/>}复制代码</button></div><pre><code dangerouslySetInnerHTML={{__html:html}}/></pre></div>;
}
export function FilePreview({preview,line=1,review,onClose,onReference,onError}:{preview:Preview;line?:number;review?:Wire|null;onClose:()=>void;onReference:(path:string,line:number)=>void;onError:(e:unknown)=>void}){
  const [layout,setLayout]=useState('split'),[target,setTarget]=useState(String(line)),[selected,setSelected]=useState(line),[copied,setCopied]=useState(false);
  const container=useRef<HTMLDivElement>(null);
  const scrollTo=(next:number)=>{setSelected(next);container.current?.querySelector(`[data-line="${next}"]`)?.scrollIntoView({block:'center'});};
  useEffect(()=>{scrollTo(line);},[line,preview.path]);
  const renderCode=(text:string,name:string)=>{const html=highlighted(text,languageFor(preview.path));return <div className="review-code"><div className="review-side-label">{name}</div><div className="numbered-code"><div className="line-gutter">{text.split('\n').map((_,i)=><button key={i} data-line={i+1} className={selected===i+1?'selected-line':''} onClick={()=>{setTarget(String(i+1));setSelected(i+1);}}>{i+1}</button>)}</div><pre><code dangerouslySetInnerHTML={{__html:html}}/></pre></div></div>;};
  const text=review?review.new.content:preview.content;
  return <Modal title={preview.path} wide onClose={onClose}><div className="preview-toolbar"><span>{review?`${review.stage==='staged'?'已暂存':'未暂存'}差异`:'只读预览'}{preview.truncated||review?.old.truncated||review?.new.truncated?' · 内容已截取':''}</span><div className="preview-controls">{review&&<><button className={layout==='split'?'selected':''} onClick={()=>setLayout('split')}>左右对照</button><button className={layout==='patch'?'selected':''} onClick={()=>setLayout('patch')}>补丁</button></>}<form onSubmit={e=>{e.preventDefault();scrollTo(Math.max(1,Number(target)||1));}}><input aria-label="跳转行号" type="number" min={1} value={target} onChange={e=>setTarget(e.target.value)}/><button>跳转</button></form><IconButton label="复制文件内容" onClick={()=>void navigator.clipboard.writeText(text).then(()=>setCopied(true)).catch(onError)}>{copied?<Check size={14}/>:<Copy size={14}/>}</IconButton><button className="text-button" onClick={()=>void window.pi.openEditor(preview.path,selected).catch(onError)}>VS Code<ArrowUpRight size={13}/></button><button className="text-button" onClick={()=>onReference(preview.path,selected)}>引用到消息</button></div></div><div className="review-scroll" ref={container}>{review&&layout==='patch'?<pre className="file-preview diff-preview">{(review.patch||'新增文件，没有已有版本可比较。').split('\n').map((line:string,i:number)=><div key={i} className={line.startsWith('+')?'added-line':line.startsWith('-')?'removed-line':line.startsWith('@@')?'hunk-line':''}>{line||' '}</div>)}</pre>:review?<div className="split-review">{renderCode(review.old.content,review.oldLabel)}{renderCode(review.new.content,review.newLabel)}</div>:renderCode(preview.content,preview.path)}</div></Modal>;
}
export function McpPanel({onClose,onError}:{onClose:()=>void;onError:(e:unknown)=>void}){
  const [data,setData]=useState<Wire|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const refresh=async(name?:string)=>{setLoading(true);setError('');try{setData(await window.pi.mcpStatus(name));}catch(e){setError(String(e));}finally{setLoading(false);}};
  useEffect(()=>{void refresh();},[]);
  const labels:Record<string,string>={connected:'已连接',disabled:'已禁用',failed:'连接失败',disconnected:'已断开','needs-auth':'需要登录',starting:'启动中',connecting:'连接中'};
  return <Modal title="MCP 连接" onClose={onClose} wide><div className="modal-body mcp-panel"><div className="mcp-intro"><div><h3>当前会话的工具服务器</h3><p>状态来自 Pi 当前连接；刷新和重连不会调用模型。</p></div><button className="secondary-button" disabled={loading} onClick={()=>void refresh()}>{loading?<LoaderCircle size={15} className="spin"/>:<RefreshCw size={15}/>}刷新状态</button></div>{error&&<div className="notice error"><CircleAlert size={16}/>{error}</div>}{data?.operationErrors?.map((e:string,i:number)=><div className="notice error" key={i}>{e}</div>)}<div className="mcp-grid">{data?.servers?.map((server:Wire)=><article className="mcp-card" key={server.name}><div className="mcp-card-heading"><Plug size={20}/><strong>{server.name}</strong><span className={`mcp-state ${server.state}`}>{labels[server.state]||server.state}</span></div><div className="mcp-card-meta"><span>{server.tools??'—'} 个工具</span><span>{server.exposure}</span></div>{server.error&&<pre>{server.error}</pre>}{server.state==='needs-auth'&&<p>在 Pi CLI 中执行 /mcp login {server.name}，再刷新状态。</p>}<button className="secondary-button" disabled={loading||server.state==='disabled'} onClick={()=>void refresh(server.name)}>重新连接</button></article>)}</div>{data?.servers?.length===0&&!loading&&<div className="panel-empty"><Plug size={26}/><p>当前没有可显示的 MCP 连接</p></div>}{data?.diagnostics?.map((text:string,i:number)=><p className="mcp-diagnostic" key={i}>{text}</p>)}{data&&<div className="mcp-updated">上次检查：{new Date(data.checkedAt).toLocaleTimeString()}<button className="text-button" onClick={()=>void window.pi.revealConfig().catch(onError)}>打开 Pi 配置目录</button></div>}</div></Modal>;
}
