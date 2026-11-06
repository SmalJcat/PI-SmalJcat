import { PiRpc } from '../electron/rpc.mjs';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const temp=await mkdtemp(path.join(os.tmpdir(),'pi-fork-contract-'));
const cwd=path.join(temp,'work');await mkdir(cwd);
const original=path.join(temp,'original.jsonl');const id=randomUUID();
const content=[{type:'session',version:3,id,cwd,timestamp:new Date().toISOString()},{type:'message',id:'user1',parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:'A saved prompt for fork verification. Do not run.',timestamp:Date.now()}}].map(JSON.stringify).join('\n')+'\n';await writeFile(original,content);
const executable=process.env.PI_DESKTOP_EXECUTABLE || path.resolve(import.meta.dirname,'../../pi.exe');
const rpc=new PiRpc(executable,{cwd,args:['--fork',original,'--session-dir',path.join(temp,'sessions'),'--offline','--no-extensions','--no-tools','--no-context-files','--no-skills']});
try{
 const state=await rpc.request('get_state');const entries=await rpc.request('get_entries');
 assert.notEqual(state.sessionId,id);assert.notEqual(state.sessionFile,original);assert.equal(state.isStreaming,false);
 assert.ok(entries.entries.some(e=>e.type==='message'&&e.message.content.includes('fork verification')));
 assert.equal(await readFile(original,'utf8'),content);
 console.log(JSON.stringify({passed:true,originalUnchanged:true,historyRetained:true,modelRequests:0,sessionFiles:'isolated temp directory'}));
}finally{await rpc.stop();await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
