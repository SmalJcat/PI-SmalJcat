import { chromium } from 'playwright';
import { createServer } from 'vite';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { mcpContentChecks } from './mcp-content-ui.mjs';

const artifacts = 'artifacts/mcp-content';
await mkdir(artifacts, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
let browser;
const errors = [], checks = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CI ? undefined : [
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  ].find(existsSync) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const model = { id: 'fixture', name: 'Fixture', provider: 'local', input: ['text'], contextWindow: 128000 };
    const snapshot = { generation: 1, cwd: 'D:\\fixture', state: { sessionId: 'fixture', model }, messages: [], models: [model], levels: ['off'], commands: [], stats: {} };
    const servers = [
      { name: 'content', transport: 'stdio', command: 'fixture', connected: false, capabilities: { resources: {}, prompts: {} } },
      { name: 'tool-server', transport: 'stdio', command: 'fixture', connected: false, capabilities: { tools: {} } },
    ];
    const calls = [];
    window.mcpFixture = { calls, servers };
    const record = (method, options) => { calls.push({ method, ...options }); };
    window.pi = {
      bootstrap: async () => ({ preferences: { lastWorkspace: 'D:\\fixture', recentWorkspaces: [] }, version: '0.7.1', agentDir: 'fixture' }),
      connect: async () => snapshot, snapshot: async () => snapshot, sessions: async () => [], files: async () => [], changes: async () => ({ available: false, files: [] }),
      onEvent: () => () => {}, onFileDrop: () => () => {}, startupReady: async () => ({}), antigravity: async () => ({}), sessionAccess: async () => ({ available: true }),
      mcpStatus: async () => ({ checkedAt: Date.now(), servers: [] }),
      mcpServers: async () => ({ servers: structuredClone(servers), warnings: [] }),
      mcpConnect: async name => { const server = servers.find(server => server.name === name); server.connected = true; return { server: structuredClone(server) }; },
      mcpDisconnect: async name => { servers.find(server => server.name === name).connected = false; return { disconnected: [name] }; },
      mcpTools: async options => { record('tools/list', options); if (options.name === 'content') throw new Error('tools unavailable'); return { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }; },
      mcpCall: async options => { record('tools/call', options); return { result: { content: [{ type: 'text', text: options.arguments.text }] } }; },
      mcpResources: async options => { record('resources/list', options); return options.cursor === undefined ? { resources: [{ name: 'hello', uri: 'fixture://hello' }], nextCursor: '下一页+/=' } : { resources: [{ name: 'binary', uri: 'fixture://binary' }] }; },
      mcpResourceTemplates: async options => { record('resources/templates/list', options); return options.cursor === undefined ? { resourceTemplates: [{ name: 'named', uriTemplate: 'fixture://{name}' }], nextCursor: 'templates-2' } : { resourceTemplates: [] }; },
      mcpResourceRead: async options => {
        record('resources/read', options);
        if (window.mcpFixture.hold) await new Promise(resolve => { window.mcpFixture.release = resolve; });
        if (options.uri === 'fixture://missing') throw new Error('Resource not found');
        return { result: { contents: [{ uri: options.uri, ...(options.uri === 'fixture://binary' ? { blob: 'AAEC', mimeType: 'application/octet-stream' } : { text: '你好🙂 <script>window.bad = true</script>', mimeType: 'text/plain' }) }] } };
      },
      mcpPrompts: async options => { record('prompts/list', options); return options.cursor === undefined ? { prompts: [{ name: 'greet', arguments: [{ name: 'name', required: true }] }], nextCursor: 'prompts-2' } : { prompts: [] }; },
      mcpPromptGet: async options => { record('prompts/get', options); return { result: { messages: [{ role: 'user', content: { type: 'text', text: `Hello ${options.arguments.name}` } }] } }; },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('.connection-pill.ready').waitFor();
  await mcpContentChecks(page, artifacts, checks);
  const calls = await page.evaluate(() => window.mcpFixture.calls);
  assert.equal(calls.filter(call => call.method === 'tools/list' && call.name === 'content').length, 0);
  assert.equal(calls.filter(call => call.method === 'prompts/get').length, 1, 'Invalid arguments never reach the bridge');
  assert.ok(calls.some(call => call.cursor === '下一页+/='));
  assert.equal(await page.evaluate(() => window.bad), undefined, 'Resource HTML stays inert text');

  // Hold a read across tab unmount; its late result must not overwrite prompts.
  await page.getByRole('button', { name: 'MCP 连接', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'MCP 连接', exact: true });
  await dialog.getByRole('tab', { name: '桌面调试', exact: true }).click();
  const content = dialog.locator('.mcp-server').filter({ has: page.getByText('content', { exact: true }) });
  await content.getByRole('button', { name: '连接', exact: true }).click();
  await content.locator('.mcp-tool').filter({ hasText: 'hello' }).click();
  await page.evaluate(() => { window.mcpFixture.hold = true; });
  await content.getByRole('button', { name: '读取资源', exact: true }).click();
  await page.waitForFunction(() => typeof window.mcpFixture.release === 'function');
  await content.getByRole('button', { name: '提示词', exact: true }).click();
  await content.locator('.mcp-tool').filter({ hasText: 'greet' }).click();
  await content.getByLabel('提示词参数 JSON').fill('{"name":"current"}');
  await content.getByRole('button', { name: '获取提示词', exact: true }).click();
  await content.locator('.mcp-result').filter({ hasText: 'Hello current' }).waitFor();
  await page.evaluate(async () => { window.mcpFixture.release(); await new Promise(resolve => setTimeout(resolve, 50)); });
  assert.match(await content.locator('.mcp-result').innerText(), /Hello current/);
  assert.equal(await content.locator('.mcp-result').filter({ hasText: '你好🙂' }).count(), 0);
  checks.push('资源 HTML 保持纯文本、无效参数不请求、切换后迟到结果隔离');
  assert.deepEqual(errors, []);
  await writeFile(`${artifacts}/result.json`, JSON.stringify({ success: true, checks, errors }, null, 2));
  console.log(`MCP content UI: ${checks.length} checks passed`);
} finally { try { await browser?.close(); } finally { await server.close(); } }
