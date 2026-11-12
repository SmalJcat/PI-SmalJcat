// Loopback-only Streamable HTTP fixture. No model calls or user configuration.
import http from 'node:http';
import { appendFileSync } from 'node:fs';
const log = process.argv[2];
const mode = process.argv[3] || 'normal';
const record = value => appendFileSync(log, JSON.stringify(value) + '\n');
let revision = 0;
const streams = new Set();
const json = (res, status, value, headers = {}) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
};
const sse = (res, value, id) => {
  if (id) res.write(`id: ${id}\r\n`);
  res.write('event: message\r\n');
  for (const line of JSON.stringify(value, null, 2).split('\n')) res.write(`data: ${line}\r\n`);
  res.write('\r\n');
};
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const message = body ? JSON.parse(body) : {};
  record({ method: req.method, url: req.url, headers: req.headers, message });
  if (message.method === 'initialize') {
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 300));
    const headers = mode === 'stateless' ? {} : { 'Mcp-Session-Id': mode === 'bad-session' ? 'invalid session' : 'fixture-session' };
    const capabilities = mode === 'content-only' ? { resources: {}, prompts: {} } : { tools: { listChanged: true } };
    json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'http-fixture', version: '1' }, capabilities } }, headers);
    return;
  }
  if ((mode !== 'stateless' && req.headers['mcp-session-id'] !== 'fixture-session') || req.headers['mcp-protocol-version'] !== '2025-06-18') {
    json(res, 400, { error: 'Missing session/protocol header' }); return;
  }
  if (req.method === 'DELETE') { res.writeHead(204);res.end();return; }
  if (req.method === 'GET') {
    if (mode === 'stateless' || mode === 'no-get') { res.writeHead(405);res.end();return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': keepalive\r\n\r\n');streams.add(res);
    record({ event: 'stream-open' });
    res.on('close', () => { streams.delete(res);record({ event: 'stream-close' }); });
    return;
  }
  if (message.method === 'notifications/initialized') {
    res.writeHead(202);res.end();return;
  }
  if (mode === 'content-only') {
    const reply = result => json(res, 200, { jsonrpc: '2.0', id: message.id, result });
    const error = text => json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: text } });
    const params = message.params || {};
    if (message.method === 'resources/list') {
      reply(params.cursor === undefined ? { resources: [{ name: 'hello', uri: 'fixture://hello' }], nextCursor: '下一页+/=' } : { resources: [{ name: 'binary', uri: 'fixture://binary' }] }); return;
    }
    if (message.method === 'resources/templates/list') {
      reply(params.cursor === undefined ? { resourceTemplates: [{ name: 'named', uriTemplate: 'fixture://{name}' }], nextCursor: 'templates-2' } : { resourceTemplates: [] }); return;
    }
    if (message.method === 'resources/read') {
      if (params.uri === 'fixture://hello') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        sse(res, { jsonrpc: '2.0', id: message.id, result: { contents: [{ uri: params.uri, text: '你好🙂 HTTP resource', mimeType: 'text/plain' }] } });
        return;
      }
      if (params.uri === 'fixture://binary') reply({ contents: [{ uri: params.uri, blob: 'AAEC', mimeType: 'application/octet-stream' }] });
      else if (params.uri === 'fixture://oversized') reply({ contents: [{ uri: params.uri, text: 'x'.repeat(256 * 1024) }] });
      else if (params.uri === 'fixture://malformed') reply({ contents: null });
      else error('Resource not found');
      return;
    }
    if (message.method === 'prompts/list') {
      reply(params.cursor === undefined ? { prompts: [{ name: 'greet', arguments: [{ name: 'name', required: true }] }], nextCursor: 'prompts-2' } : { prompts: [] }); return;
    }
    if (message.method === 'prompts/get') {
      if (params.name !== 'greet' || typeof params.arguments?.name !== 'string') error('Invalid prompt or missing name');
      else reply({ messages: [{ role: 'user', content: { type: 'text', text: `Hello ${params.arguments.name}` } }] });
      return;
    }
    error('Method unavailable'); return;
  }
  if (message.method === 'tools/list') {
    json(res, 200, { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: `echo-${revision}`, inputSchema: { type: 'object' } }] } });return;
  }
  const name = message.params?.name;
  if (name === 'expire') { res.writeHead(404);res.end();return; }
  if (name === 'hang') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });res.write(': waiting\n\n');
    res.on('close', () => record({ event: 'hang-close' }));return;
  }
  if (name === 'notify') {
    revision++;
    for (const stream of streams) sse(stream, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, `change-${revision}`);
    json(res, 200, { jsonrpc: '2.0', id: message.id, result: { streams: streams.size } });return;
  }
  if (name === 'silent-change') {
    revision++;
    json(res, 200, { jsonrpc: '2.0', id: message.id, result: {} });return;
  }
  if (name === 'close-stream') {
    for (const stream of streams) stream.end();
    json(res, 200, { jsonrpc: '2.0', id: message.id, result: {} });return;
  }
  if (name === 'wrong-id') { json(res, 200, { jsonrpc: '2.0', id: 999999, result: {} });return; }
  if (name === 'denied') { json(res, 403, { detail: 'secret must not appear in client error' });return; }
  if (name === 'bad-json') { res.writeHead(200, { 'Content-Type': 'application/json' });res.end('not json');return; }
  if (name === 'oversized') { res.writeHead(200, { 'Content-Type': 'application/json' });res.end('x'.repeat(4 * 1024 * 1024 + 1));return; }
  if (name === 'sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    sse(res, { jsonrpc: '2.0', id: 999999, result: {} });
    sse(res, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '你好🙂 SSE' }] } });
    res.on('close', () => record({ event: 'sse-close' }));return;
  }
  json(res, 200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } });
});
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/mcp`));
