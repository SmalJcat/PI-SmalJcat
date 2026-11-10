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
    json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'http-fixture', version: '1' }, capabilities: { tools: { listChanged: true } } } }, headers);
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
