import test from 'node:test';
import assert from 'node:assert/strict';
import {mentionAt,insertReference,parseLocalLink,changeGroups} from '../src/workflows.mjs';
import {emptyTranscript,reduceTranscript} from '../src/transcript.mjs';
test('file mention uses cursor boundary and preserves following text',()=>{
 assert.deepEqual(mentionAt('检查 @src/ma 后面的字',10),{query:'src/ma',start:3,end:10});
 assert.equal(mentionAt('mail@example.com',16),null);
 assert.deepEqual(insertReference('看 @file 后续',{start:2,end:7},'src/a b.ts'),{text:'看 @"src/a b.ts" 后续',cursor:16});
});
test('local links preserve line references and reject unsafe schemes',()=>{
 assert.deepEqual(parseLocalLink('src/main.rs:42'),{path:'src/main.rs',line:42});
 assert.deepEqual(parseLocalLink('src/main.rs#L8'),{path:'src/main.rs',line:8});
 assert.equal(parseLocalLink('javascript:alert(1)'),null);
 assert.equal(parseLocalLink('https://example.com'),null);
});
test('mixed status appears in both staged and working groups',()=>{
 const files=[{path:'a',status:'MM'},{path:'b',status:'??'},{path:'c',status:'D '}];
 const groups=changeGroups(files);
 assert.deepEqual(groups[0].files.map(f=>f.path),['a','b']);assert.deepEqual(groups[1].files.map(f=>f.path),['a','c']);
});
test('compaction stays busy until the authoritative idle state is received',()=>{
 let state=reduceTranscript(emptyTranscript(),{type:'compaction_start',reason:'threshold'});
 assert.equal(state.running,true);
 state=reduceTranscript(state,{type:'compaction_end',result:{summary:'kept context'}});
 assert.equal(state.running,true);
 assert.equal(reduceTranscript(state,{type:'agent_settled'}).running,false);
});
