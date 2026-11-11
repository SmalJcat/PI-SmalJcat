import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import desktopPermissions from '../extensions/desktop-permissions.mjs';
import {contextMeasurement,compactTokens} from '../src/composer-status.mjs';

test('real extension handler waits for a correlated approval and fails closed on cancel or missing UI',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-permission-hook-')),file=path.join(root,'policy.json');
  const previousFile=process.env.PI_DESKTOP_PERMISSION_FILE,previousToken=process.env.PI_DESKTOP_PERMISSION_TOKEN;
  process.env.PI_DESKTOP_PERMISSION_FILE=file;process.env.PI_DESKTOP_PERMISSION_TOKEN='test-token';
  try {
    fs.writeFileSync(file,JSON.stringify({mode:'ask',rules:{}}));
    let hook,resolve,request;
    desktopPermissions({registerCommand(){},on(name,handler){if(name==='tool_call')hook=handler;}});
    const event={toolName:'write',toolCallId:'tool-1',input:{path:'approved.txt',content:'write after approval'}};
    const context={cwd:root,hasUI:true,ui:{input:async(title,value)=>{request={title,...JSON.parse(value)};return new Promise(done=>{resolve=done;});}}};
    const pending=hook(event,context);assert.equal(request.toolCallId,'tool-1');assert.equal(request.token,'test-token');
    assert.equal(fs.existsSync(path.join(root,'approved.txt')),false);
    resolve('deny');assert.equal((await pending).block,true);
    const allowed=hook(event,context);resolve('allow');assert.equal(await allowed,undefined);
    const cancelled=hook(event,context);resolve(undefined);assert.equal((await cancelled).block,true);
    assert.equal((await hook(event,{...context,hasUI:false})).block,true);
    fs.writeFileSync(file,JSON.stringify({mode:'full-access',rules:{}}));
    const tampered=hook(event,context);resolve('deny');assert.equal((await tampered).block,true,'Editing the runtime metadata file cannot grant authority; the native host decides');
  } finally {
    if(previousFile===undefined)delete process.env.PI_DESKTOP_PERMISSION_FILE;else process.env.PI_DESKTOP_PERMISSION_FILE=previousFile;
    if(previousToken===undefined)delete process.env.PI_DESKTOP_PERMISSION_TOKEN;else process.env.PI_DESKTOP_PERMISSION_TOKEN=previousToken;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('context measurements preserve unknown, zero and current-window usage independently of cumulative tokens',()=>{
  assert.equal(contextMeasurement(null,200000).known,false);
  assert.equal(contextMeasurement({tokens:null,percent:70},200000).known,false);
  assert.equal(contextMeasurement({used:0,size:200000}).percent,0);
  assert.equal(Math.round(contextMeasurement({used:364000,size:828000}).percent),44);
  assert.equal(contextMeasurement({used:364000,size:828000}).remaining,464000);
  assert.equal(contextMeasurement({tokens:1200,contextWindow:200000,totalTokens:999999999}).used,1200);
  for(const used of [-1,NaN,'123',Infinity,Number.MAX_SAFE_INTEGER+1]) assert.equal(contextMeasurement({used,size:200000}).known,false);
  assert.equal(contextMeasurement({used:300000,size:200000}).remaining,0);
  assert.equal(compactTokens(364000),'364k');assert.equal(compactTokens(null),'—');
});
