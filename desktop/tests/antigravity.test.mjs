import test from 'node:test';
import assert from 'node:assert/strict';
import { acpDraftKey, acpModelWindow, acpOptions, applyAntigravity, emptyAntigravity } from '../src/antigravity.mjs';
test('ACP patches remain ordered, correlate tools, and reset only their own session', () => {
  let state=applyAntigravity(emptyAntigravity(),{revision:1,sessionId:'a',cwd:'work',messages:[],tools:{}});
  state=applyAntigravity(state,{revision:3,sessionId:'a',message:{_key:'reply',role:'assistant',content:'中文🙂'}});
  assert.equal(applyAntigravity(state,{revision:2,messages:[]}),state);
  state=applyAntigravity(state,{revision:4,toolId:'tool',tool:{status:'done'}});
  assert.equal(state.tools.tool.status,'done');assert.equal(state.messages.length,1);
  state=applyAntigravity(state,{revision:5,sessionId:'b',reset:true});
  assert.deepEqual(state.messages,[]);assert.deepEqual(state.tools,{});assert.ok(acpDraftKey(state).startsWith('antigravity-draft:'));
});
test('Grouped ACP options preserve provider identifiers without inventing choices',()=>{
  assert.deepEqual(acpOptions({options:[{name:'Group',options:[{name:'Claude',value:'claude-opus-5-5'}]},{name:'unsupported'}]}),[{name:'Claude',value:'claude-opus-5-5'}]);
  assert.equal(acpModelWindow('gemini-4-argon'), 1_000_000);
  assert.equal(acpModelWindow('claude-opus-5-5'), 200_000);
  assert.equal(acpModelWindow('gpt-oss-120b-medium'), 128_000);
  assert.equal(acpModelWindow('fixture-model'), 0);
});
