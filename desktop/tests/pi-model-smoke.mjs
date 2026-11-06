// Explicit, opt-in real provider verification; uses no persistent session or tools.
import { PiRpc } from '../electron/rpc.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '../..');
const client = new PiRpc(process.env.PI_DESKTOP_EXECUTABLE || path.join(root, 'pi.exe'), {
  cwd: root,
  args: ['--no-session', '--offline', '--no-tools', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates'],
});
let resolveSettled, rejectSettled, timer;
const settled = new Promise((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
settled.catch(() => {});
let text = '', errorMessage = '', deltaCount = 0;
client.on('event', event => {
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') deltaCount++;
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    text = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
    errorMessage = event.message.errorMessage || '';
  }
  if (event.type === 'agent_settled') resolveSettled();
  if (event.type === 'transport_exit') rejectSettled(new Error(event.message));
});
try {
  const state = await client.request('get_state');
  console.log(JSON.stringify({ provider: state.model?.provider, model: state.model?.id }));
  await client.request('set_auto_retry', { enabled: false });
  if (state.model.reasoning) {
    const { levels } = await client.request('get_available_thinking_levels');
    await client.request('set_thinking_level', { level: levels[0] });
  }
  timer = setTimeout(() => rejectSettled(new Error('Real model response exceeded 60 seconds')), 60000);
  await client.request('prompt', { message: 'Reply with exactly PI_DESKTOP_OK. Do not call tools.' });
  await settled;
  assert.equal(errorMessage, '', errorMessage);
  assert.match(text, /PI_DESKTOP_OK/);
  console.log(JSON.stringify({ result: text, streamedDeltas: deltaCount, persistedSession: false, passed: true }));
} finally {
  clearTimeout(timer);
  await client.stop();
}
