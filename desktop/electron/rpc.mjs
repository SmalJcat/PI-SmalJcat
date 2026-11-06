import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';

// JSONL is delimited by LF only. U+2028/U+2029 are valid JSON string content.
export class JsonLines {
  decoder = new StringDecoder('utf8');
  buffer = '';
  constructor(onRecord, onError = () => {}) { this.onRecord = onRecord; this.onError = onError; }
  push(chunk) {
    this.buffer += this.decoder.write(chunk);
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      this.parse(line);
    }
    if (this.buffer.length > 64 * 1024 * 1024) {
      this.buffer = '';
      this.onError(new Error('Pi 返回了超过 64 MB 的单条记录。'));
    }
  }
  end() { this.buffer += this.decoder.end(); if (this.buffer.trim()) this.parse(this.buffer); this.buffer = ''; }
  parse(line) {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line); } catch { this.onError(new Error(`无法解析 Pi 记录：${line.slice(0, 160)}`)); return; }
    this.onRecord(record);
  }
}

export class PiRpc extends EventEmitter {
  pending = new Map();
  busy = false;
  stderr = '';
  closed = false;
  stopping = false;
  constructor(executable, { cwd, args = [], env = process.env, prefixArgs = [] } = {}) {
    super();
    const childEnv = { ...env, PI_SKIP_VERSION_CHECK: '1' };
    for (const key of ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL', 'ELECTRON_RUN_AS_NODE']) delete childEnv[key];
    this.child = spawn(executable, [...prefixArgs, '--mode', 'rpc', ...args], {
      cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    const parser = new JsonLines(record => this.receive(record), error => this.emit('event', { type: 'transport_warning', message: error.message }));
    this.child.stdout.on('data', chunk => parser.push(chunk));
    this.child.stdout.on('end', () => parser.end());
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-16000); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('close', (code, signal) => {
      this.fail(new Error(this.stopping ? 'Pi 已关闭' : `Pi 进程退出 (${code ?? signal})。${this.stderr ? `\n${this.stderr}` : ''}`));
      this.emit('closed');
    });
  }
  receive(record) {
    if (record.type === 'response') {
      const pending = this.pending.get(record.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(record.id);
        if (record.success) pending.resolve(record.data);
        else pending.reject(new Error(record.error || `${record.command} 失败`));
      }
      return;
    }
    if (record.type === 'agent_start' || record.type === 'compaction_start') this.busy = true;
    if (record.type === 'agent_settled') this.busy = false;
    this.emit('event', record);
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.busy = false;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    if (!this.stopping) this.emit('event', { type: 'transport_exit', message: error.message });
  }
  write(record) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.child.stdin.destroyed) return reject(new Error('Pi 未连接，请重新连接。'));
      // The callback waits until the write is flushed, including pipe backpressure.
      this.child.stdin.write(`${JSON.stringify(record)}\n`, 'utf8', error => error ? reject(error) : resolve());
    });
  }
  request(type, data = {}, timeout = 120000) {
    if (this.closed) return Promise.reject(new Error('Pi 未连接，请重新连接。'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi 命令 ${type} 超时；请查看连接诊断。`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...data, type, id }).catch(error => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); reject(error);
      });
    });
  }
  async stop() {
    this.stopping = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const closed = new Promise(resolve => this.child.once('close', resolve));
    this.child.stdin.end();
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
    clearTimeout(timer);
    if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid) {
      if (process.platform === 'win32') {
        await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve()));
      } else this.child.kill('SIGKILL');
    }
    this.fail(new Error('Pi 已关闭'));
  }
}
