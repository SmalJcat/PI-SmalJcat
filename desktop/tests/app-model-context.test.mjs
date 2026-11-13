import test from 'node:test';
import assert from 'node:assert/strict';
import desktopAppContext from '../extensions/desktop-app-context.mjs';

function fixture() {
  let hook;
  let contexts = [];
  const queries = [];
  desktopAppContext({on:(name, handler)=>{assert.equal(name,'context');hook=handler;}},'test-token');
  const ctx = {hasUI:true,sessionManager:{getSessionId:()=> 'session'},ui:{input:async (title,raw,options)=>{
    queries.push({title,request:JSON.parse(raw),signal:options.signal});
    return JSON.stringify({contexts});
  }}};
  return {hook,ctx,queries,set:value=>{contexts=value;}};
}

test('App context uses the authenticated channel and preserves the original transcript', async () => {
  const f = fixture();
  f.set([{id:'app',source:'server · tool',timestamp:42,content:[{type:'text',text:'selected item'}],structuredContent:{count:7}}]);
  const original = [{role:'user',content:'ordinary prompt',timestamp:1}];
  const result = await f.hook({messages:original},f.ctx);
  assert.equal(original.length,1);
  assert.deepEqual(result.messages[0],original[0]);
  assert.match(result.messages[1].content[0].text,/server · tool.*app/);
  assert.match(result.messages[1].content[0].text,/selected item\n\{"count":7\}/);
  assert.equal(result.messages[1].role,'user');
  assert.equal(result.messages[1].timestamp,42);
  assert.equal(f.queries[0].title,'PI_DESKTOP_APP_CONTEXT');
  assert.deepEqual(f.queries[0].request,{token:'test-token',sessionId:'session'});
  assert.ok(f.queries[0].signal instanceof AbortSignal);
});

test('each model request reads the latest independent App snapshots and supports clearing', async () => {
  const f = fixture(), event = {messages:[]};
  f.set([{id:'a',source:'a',timestamp:1,content:[{type:'text',text:'old'}]}]);
  assert.match((await f.hook(event,f.ctx)).messages[0].content[0].text,/old/);
  f.set([{id:'a',source:'a',timestamp:2,structuredContent:{latest:true}},{id:'b',source:'b',timestamp:3,content:[{type:'text',text:'other app'}]}]);
  const result = await f.hook(event,f.ctx);
  assert.equal(result.messages.length,2);
  assert.match(result.messages[0].content[0].text,/latest/);
  assert.doesNotMatch(JSON.stringify(result),/old/);
  assert.match(result.messages[1].content[0].text,/other app/);
  f.set([]);
  assert.equal(await f.hook(event,f.ctx),undefined);
  assert.deepEqual(event.messages,[]);
});

test('cancelled or malformed context replies preserve ordinary Pi input', async () => {
  const f = fixture(), event = {messages:[{role:'user',content:'keep'}]};
  for (const value of [undefined,'invalid','{}']) {
    f.ctx.ui.input=async()=>value;
    assert.equal(await f.hook(event,f.ctx),undefined);
  }
  f.ctx.ui.input=async()=>{throw new Error('cancelled');};
  assert.equal(await f.hook(event,f.ctx),undefined);
  assert.deepEqual(event.messages,[{role:'user',content:'keep'}]);
});

test('context hooks require a desktop token and a UI connection', async () => {
  let registered=false;
  desktopAppContext({on:()=>{registered=true;}},'');
  assert.equal(registered,false);
  const f=fixture();f.ctx.hasUI=false;
  assert.equal(await f.hook({messages:[]},f.ctx),undefined);
  assert.equal(f.queries.length,0);
});
