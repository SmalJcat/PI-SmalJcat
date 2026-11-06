// Verify the shipped Pi's actual tool selection without making a model request.
import { PiRpc } from '../electron/rpc.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-agent-contract-'));
const audit = path.join(temp, 'audit.mjs');
await writeFile(audit, `export default pi => pi.registerCommand('desktop-agent-contract', { handler: async (_,ctx) => ctx.ui.notify('PI_AGENT_CONTRACT:'+JSON.stringify(pi.getActiveTools()),'info') });`);
const executable = process.env.PI_DESKTOP_EXECUTABLE || path.resolve(import.meta.dirname, '../../pi.exe');
const rpc = new PiRpc(executable, { cwd: temp, args: ['--no-session', '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--tools', 'read,grep,find,ls', '--exclude-tools', 'mcp__*', '-e', audit] });
const notifications = [];
rpc.on('event', event => { if (event.type === 'extension_ui_request' && event.method === 'notify') notifications.push(event.message); });
try {
  const commands = await rpc.request('get_commands');
  assert.ok(commands.commands.some(command => command.name === 'desktop-agent-contract'));
  await rpc.request('prompt', { message: '/desktop-agent-contract' });
  const response = notifications.find(message => message.startsWith('PI_AGENT_CONTRACT:'));
  assert.ok(response, 'Pi did not return the active tool selection');
  const tools = JSON.parse(response.slice('PI_AGENT_CONTRACT:'.length)).sort();
  assert.deepEqual(tools, ['find', 'grep', 'ls', 'read']);
  console.log(JSON.stringify({ passed: true, tools, mcpDisabled: true, modelRequests: 0 }));
} finally { await rpc.stop(); await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
