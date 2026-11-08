import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, LoaderCircle, Settings2, ShieldAlert, ShieldCheck } from './icons';
import { Modal } from './components';
import { compactTokens, contextMeasurement, defaultPermissionRules, permissionModes } from './composer-status.mjs';
import type { Wire } from './types';
import './composer-status.css';

function usePopover(open: boolean, close: (focus?: boolean)=>void, width: number, focusOnOpen: boolean, alignStart=false) {
  const trigger=useRef<HTMLButtonElement>(null), panel=useRef<HTMLDivElement>(null);
  const [position,setPosition]=useState({left:12,top:12,width,maxHeight:520});
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{
      const anchor=trigger.current?.getBoundingClientRect(), element=panel.current;
      if(!anchor||!element)return;
      const w=Math.min(width,innerWidth-24), maxHeight=Math.min(560,innerHeight-24), height=Math.min(element.scrollHeight,maxHeight);
      setPosition({width:w,maxHeight,left:Math.max(12,Math.min(alignStart?anchor.left:anchor.right-w,innerWidth-w-12)),top:Math.max(12,anchor.top-height-10>=12?anchor.top-height-10:Math.min(anchor.bottom+10,innerHeight-height-12))});
    };
    place(); const observer=new ResizeObserver(place); if(panel.current)observer.observe(panel.current);if(trigger.current)observer.observe(trigger.current);
    addEventListener('resize',place);addEventListener('scroll',place,true);
    return()=>{observer.disconnect();removeEventListener('resize',place);removeEventListener('scroll',place,true);};
  },[open,width,alignStart]);
  useEffect(()=>{
    if(!open)return;
    if(focusOnOpen) requestAnimationFrame(()=>{const button=panel.current?.querySelector<HTMLElement>('[aria-checked=true],button'); if(button)button.focus();else panel.current?.focus();});
    const outside=(event:PointerEvent|FocusEvent)=>{const node=event.target as Node;if(!panel.current?.contains(node)&&!trigger.current?.contains(node))close();};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopPropagation();close(true);}};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',outside);document.addEventListener('keydown',escape,true);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside);document.removeEventListener('keydown',escape,true);};
  },[open,focusOnOpen]);
  return {trigger,panel,position};
}

export function PermissionControl({scope,mode,rules,configFile,configError,locked,onChange,onError}: {
  scope:string;mode?:string;rules?:Wire;configFile?:string;configError?:string;locked:boolean;
  onChange:(mode:string,rules?:Wire)=>Promise<void>;onError:(error:unknown)=>void;
}) {
  const [open,setOpen]=useState(false),[custom,setCustom]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState('');
  const [allow,setAllow]=useState(''),[deny,setDeny]=useState(''),[edits,setEdits]=useState(false),[external,setExternal]=useState(false);
  const flight=useRef(false), form=useRef<HTMLFormElement>(null), id=useId();
  const close=(focus=false)=>{setOpen(false);if(focus)popover.trigger.current?.focus();};
  const popover=usePopover(open,close,360,true,true);
  const current=permissionModes.find(item=>item.id===mode);
  const choose=async(value:string,nextRules?:Wire)=>{
    if(locked||flight.current)return;
    flight.current=true;setPending(true);setError('');
    let success=false;
    try {await onChange(value,nextRules);setCustom(false);setOpen(false);success=true;}
    catch(error){setError(String(error));if(!custom)onError(error);}
    finally{flight.current=false;setPending(false);requestAnimationFrame(()=>{if(success)popover.trigger.current?.focus();else if(custom)form.current?.querySelector('textarea')?.focus();else popover.panel.current?.querySelector<HTMLButtonElement>(`[data-permission-mode="${value}"]`)?.focus();});}
  };
  const select=(value:string)=>{
    if(value==='custom') {const value={...defaultPermissionRules(),...rules};setAllow(value.allowTools.join('\n'));setDeny(value.denyTools.join('\n'));setEdits(value.allowWorkspaceEdits);setExternal(value.allowExternalReads);setError('');setOpen(false);setCustom(true);}
    else void choose(value);
  };
  const move=(event:React.KeyboardEvent<HTMLButtonElement>)=>{
    const buttons=Array.from(popover.panel.current?.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]:not(:disabled)')||[]), current=buttons.indexOf(event.currentTarget);
    const next=event.key==='ArrowDown'?(current+1)%buttons.length:event.key==='ArrowUp'?(current-1+buttons.length)%buttons.length:event.key==='Home'?0:event.key==='End'?buttons.length-1:-1;
    if(next>=0){event.preventDefault();buttons[next]?.focus();}
  };
  return <>
    <button ref={popover.trigger} type="button" className="composer-access permission-trigger" data-mode={mode} aria-label={`${scope} 权限`} aria-haspopup="menu" aria-expanded={open} aria-controls={open?id:undefined} disabled={locked||pending||!mode} onClick={()=>setOpen(value=>!value)}>{pending?<LoaderCircle size={17} className="spin"/>:<ShieldAlert size={17}/>}<span>{current?.short||'权限未就绪'}</span><ChevronDown size={12}/></button>
    {open&&createPortal(<div ref={popover.panel} id={id} role="menu" aria-label={`${scope} 权限设置`} className="composer-status-popover permission-menu" style={popover.position}>
      <div className="status-popover-heading">应如何批准操作？</div>
      {permissionModes.map(item=><button key={item.id} type="button" role="menuitemradio" aria-checked={mode===item.id} data-permission-mode={item.id} disabled={locked||pending} onKeyDown={move} onClick={()=>select(item.id)}>{item.id==='custom'?<Settings2 size={20}/>:item.id==='smart'?<ShieldCheck size={20}/>:<ShieldAlert size={20}/>}<span><strong>{item.name}</strong><small>{scope==='Antigravity'&&item.id!=='full-access' ? item.id==='smart'?'自动批准 CLI 请求中的工作区常规读写':item.id==='custom'?'按规则处理 CLI 发来的授权请求':'逐次确认 CLI 发来的授权请求' : item.detail}</small></span>{mode===item.id&&<Check size={18}/>}</button>)}
    </div>,document.body)}
    {custom&&<Modal title={`${scope} 自定义权限`} onClose={()=>{if(!pending)setCustom(false);}}><form ref={form} className="modal-body permission-rules" onSubmit={event=>{event.preventDefault();void choose('custom',{allowTools:allow.split(/[\n,]/).map(s=>s.trim()).filter(Boolean),denyTools:deny.split(/[\n,]/).map(s=>s.trim()).filter(Boolean),allowWorkspaceEdits:edits,allowExternalReads:external});}}>
      {(error||configError)&&<div className="notice error" role="alert">{error||configError}</div>}
      <label className="panel-checkbox"><input type="checkbox" disabled={pending} checked={edits} onChange={event=>setEdits(event.target.checked)}/>自动允许工作区常规文件编辑</label>
      <label className="panel-checkbox"><input type="checkbox" disabled={pending} checked={external} onChange={event=>setExternal(event.target.checked)}/>自动允许外部文件读取</label>
      <label>自动允许的工具<textarea aria-label={`${scope} 自动允许工具`} disabled={pending} value={allow} onChange={event=>setAllow(event.target.value)} placeholder={scope==='Antigravity'?'read\nsearch':'read\ngrep'} rows={3}/></label>
      <label>禁止的工具<textarea aria-label={`${scope} 禁止工具`} disabled={pending} value={deny} onChange={event=>setDeny(event.target.value)} placeholder={scope==='Antigravity'?'execute':'bash\npowershell'} rows={3}/></label>
      <small>每行一项，支持末尾 *；禁止规则优先，其余请求确认。</small>
      {configFile&&<code title={configFile}>{configFile}</code>}
      <div className="modal-actions"><button className="secondary-button" type="button" disabled={pending} onClick={()=>setCustom(false)}>取消</button><button className="primary-button" disabled={locked||pending} type="submit">{pending?<LoaderCircle size={14} className="spin"/>:<Check size={14}/>}保存并启用</button></div>
    </form></Modal>}
  </>;
}

export function ContextControl({scope,usage,windowSize,estimated=false,stale=false,compacting=false,busy=false,autoCompact,reserveTokens,cost,onSettings,connected=true,openSignal=0}: {
  scope:string;usage?:Wire|null;windowSize?:number;estimated?:boolean;stale?:boolean;compacting?:boolean;busy?:boolean;autoCompact?:boolean;reserveTokens?:number|null;cost?:Wire;onSettings?:()=>void;connected?:boolean;openSignal?:number;
}) {
  const [open,setOpen]=useState(false),[pinned,setPinned]=useState(false),timer=useRef<ReturnType<typeof setTimeout>|null>(null), id=useId();
  const close=(focus=false)=>{setOpen(false);setPinned(false);if(focus)popover.trigger.current?.focus();};
  const popover=usePopover(open,close,300,pinned), data=contextMeasurement(usage,windowSize);
  useEffect(()=>{if(openSignal){setPinned(true);setOpen(true);}},[openSignal]);
  const percent=data.known?Math.round(Math.min(100,data.percent||0)):null;
  const cancelClose=()=>{if(timer.current)clearTimeout(timer.current);};
  const leave=()=>{if(!pinned){cancelClose();timer.current=setTimeout(()=>setOpen(false),160);}};
  useEffect(()=>()=>cancelClose(),[]);
  const description=!connected?data.known?'未连接 · 上次统计':'未连接':compacting?'正在压缩':stale?'上次统计':busy?estimated?'运行中 · 估算':'运行中':estimated?'Pi 统计 · 含估算':'CLI 上报';
  return <>
    <button ref={popover.trigger} type="button" className={`context-trigger ${percent!==null&&percent>=90?'near-limit':''}`} aria-label={`${scope} 上下文用量`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id:undefined} aria-describedby={open&&!pinned?id:undefined} title={open?undefined:data.known?`${compactTokens(data.used)} / ${compactTokens(data.size)} tokens`:'等待上下文统计'} onMouseEnter={()=>{cancelClose();setOpen(true);}} onMouseLeave={leave} onClick={()=>{if(pinned)close();else{setPinned(true);setOpen(true);}}}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle className="context-ring-track" cx="12" cy="12" r="8"/><circle className={`context-ring-value ${compacting?'spin':''}`} cx="12" cy="12" r="8" pathLength="100" strokeDasharray={`${percent??0} 100`}/>{!data.known&&<circle cx="12" cy="12" r="1" fill="currentColor"/>}</svg>
    </button>
    {open&&createPortal(<div ref={popover.panel} id={id} tabIndex={-1} className="composer-status-popover context-card" role={pinned?'dialog':'tooltip'} aria-label={`${scope} 上下文信息`} aria-modal={pinned?'false':undefined} style={popover.position} onMouseEnter={cancelClose} onMouseLeave={leave}>
      <div className="status-popover-heading">上下文窗口<span>{description}</span></div>
      {data.known?<><strong className="context-card-percent">{percent}% 已用 <span>（剩余 {Math.max(0,100-(percent||0))}%）</span></strong><p>已用 <b>{compactTokens(data.used)}</b> 标记，共 <b>{compactTokens(data.size)}</b></p><progress aria-label={`${scope} 上下文占用`} value={Math.min(data.used,data.size)} max={data.size}/><div className="context-card-details"><span>剩余 {compactTokens(data.remaining)} 标记</span>{(data.percent||0)>100&&<span>已超出窗口容量</span>}</div></>:<><strong className="context-card-percent">{connected?'用量待统计':'未连接'}</strong><p>{data.size?`窗口 ${compactTokens(data.size)} 标记`:scope==='Antigravity'?'等待 CLI 上报用量与容量':'等待 Pi 返回上下文统计'}</p></>}
      {autoCompact!==undefined&&<div className="context-card-details"><span>自动压缩{autoCompact?'已开启':'已关闭'}</span>{typeof reserveTokens==='number'&&data.size&&<span>触发 {compactTokens(Math.max(0,data.size-reserveTokens))}</span>}</div>}
      {cost&&Number.isFinite(cost.amount)&&cost.amount>=0&&<details className="context-card-more"><summary>会话费用</summary><div className="context-card-details">{cost.currency} {cost.amount.toFixed(4)}</div></details>}
      {onSettings&&pinned&&<button className="context-settings" type="button" onClick={()=>{close();onSettings();}}><Settings2 size={14}/>压缩设置与历史</button>}
    </div>,document.body)}
  </>;
}

export function usePiPermissions(onError:(error:unknown)=>void) {
  const [policy,setPolicy]=useState<Wire>({requests:[]});
  useEffect(()=>{let alive=true,reading=false;const read=async()=>{if(reading||!window.pi.permissions)return;reading=true;try{const next=await window.pi.permissions();if(alive)setPolicy(next);}catch{}finally{reading=false;}};void read();const timer=setInterval(()=>void read(),600);return()=>{alive=false;clearInterval(timer);};},[]);
  const change=async(mode:string,rules?:Wire)=>{const next=await window.pi.permissions({action:'set',mode,...(rules?{rules}:{})});setPolicy(next);};
  const reply=async(id:string,allow:boolean)=>{try{const next=await window.pi.permissions({action:'reply',id,allow});setPolicy(next);}catch(error){onError(error);try{setPolicy(await window.pi.permissions());}catch{}throw error;}};
  const stop=async(request:Wire)=>{if(request.owner==='Pi')await window.pi.stop();else await window.pi.agentTasks({action:'cancel',id:request.owner});setPolicy(await window.pi.permissions());};
  return {policy,change,reply,stop};
}
export function PiPermissionDialog({request,onReply,onStop}:{request:Wire;onReply:(id:string,allow:boolean)=>Promise<void>;onStop:()=>Promise<void>}) {
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  const reply=async(allow:boolean)=>{if(pending)return;setPending(true);setError('');try{await onReply(request.id,allow);}catch(error){setError(String(error));}finally{setPending(false);}};
  return <Modal title="Pi 工具授权" onClose={()=>void reply(false)}><div className="modal-body">{error&&<div role="alert" className="notice error">{error}</div>}<div className="permission-owner">{request.owner==='Pi'?'Pi 主会话':`子代理 · ${request.owner.slice(0,8)}`}<br/>{request.cwd}</div><h3>{request.tool}</h3><pre className="permission-arguments">{JSON.stringify(request.input,null,2)}</pre><div className="modal-actions"><button className="secondary-button" disabled={pending} onClick={()=>{setPending(true);void onStop().catch(error=>setError(String(error))).finally(()=>setPending(false));}}>停止任务</button><button className="secondary-button" disabled={pending} onClick={()=>void reply(false)}>拒绝</button><button className="primary-button" disabled={pending} onClick={()=>void reply(true)}>允许一次</button></div></div></Modal>;
}
export function usePiContext(ready:boolean,active:boolean,model:Wire,generation?:number,initialUsage?:Wire) {
  const [data,setData]=useState<Wire>({}), key=`${model?.provider||''}/${model?.id||''}`;
  useEffect(()=>{
    let alive=true,reading=false;
    setData({usage:initialUsage?.contextWindow&&model?.contextWindow&&initialUsage.contextWindow!==model.contextWindow?null:initialUsage,window:model?.contextWindow,estimated:true});
    const read=async()=>{if(!alive||reading||!ready||!active||!window.pi.contextUsage)return;reading=true;try{const next=await window.pi.contextUsage();if(alive&&next.generation===generation&&next.modelKey===key)setData(next.usage?.contextWindow&&next.window&&next.usage.contextWindow!==next.window?{...next,usage:null}:next);}catch{if(alive)setData(previous=>({...previous,stale:true}));}finally{reading=false;}};
    const unsubscribe=window.pi.onEvent(({generation:next,event})=>{if(!alive||next!==generation)return;if(event.type==='context_usage'&&event.data?.modelKey===key)setData(previous=>({...previous,...event.data,stale:false}));if(event.type==='compaction_start')setData(previous=>({...previous,compacting:true,stale:true}));if(event.type==='compaction_end'){setData(previous=>({...previous,compacting:false,usage:null,stale:false}));void read();}});
    void read();const timer=setInterval(()=>void read(),2000);return()=>{alive=false;clearInterval(timer);unsubscribe();};
  },[ready,active,key,generation]);
  return data;
}
