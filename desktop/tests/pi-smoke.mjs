import assert from 'node:assert/strict';
import path from 'node:path';
import { PiRpc } from '../electron/rpc.mjs';
import { listSessions } from '../electron/workspace.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const executable = process.env.PI_DESKTOP_EXECUTABLE || path.join(root, 'pi.exe');
const client = new PiRpc(executable, { cwd: root, args: ['--no-session', '--offline'] });
const events = [];
client.on('event', event => {
  events.push(event.type);
  if (event.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(event.method)) void client.write({ type: 'extension_ui_response', id: event.id, cancelled: true });
});
try {
  const [state, models, commands, levels, entries, stats] = await Promise.all([
    client.request('get_state'), client.request('get_available_models'), client.request('get_commands'),
    client.request('get_available_thinking_levels'), client.request('get_entries'), client.request('get_session_stats'),
  ]);
  assert.equal(state.isStreaming, false);
  assert.equal(state.sessionFile, undefined);
  assert.ok(models.models.length > 0);
  assert.ok(Array.isArray(commands.commands));
  assert.ok(levels.levels.includes(state.thinkingLevel));
  assert.ok(Array.isArray(entries.entries));
  assert.ok(stats.sessionId);
  await client.request('clear_queue'); await client.request('abort');
  const sessions = await listSessions(root);
  console.log(JSON.stringify({ executable, modelCount: models.models.length, commandCount: commands.commands.length, thinkingLevels: levels.levels, existingSessions: sessions.length, extensionEvents: [...new Set(events)], modelRequestsMade: 0, persistedSession: false }, null, 2));
} finally { await client.stop(); }
assert.equal(client.closed, true);
console.log('Real Pi RPC smoke passed; child exited.');
