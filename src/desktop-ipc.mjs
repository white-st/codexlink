import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const desktopError = (message, code = 'DESKTOP_UNAVAILABLE', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const MAX_FRAME = 64 * 1024 * 1024;
const invalid = () => desktopError('电脑会话状态发生变化，请刷新后重试', 'DESKTOP_STATE_CHANGED');
const record = value => value && typeof value === 'object' && !Array.isArray(value);

// A separate relay keeps the verified Windows pipe handle open for this connection's lifetime.
export function windowsTransport() {
  if (process.platform !== 'win32') throw desktopError('当前系统尚未启用桌面会话协同');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('../scripts/desktop-pipe.ps1', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  return { input: child.stdout, output: child.stdin, child, close: () => { child.stdin.end(); if (child.exitCode === null) child.kill(); } };
}

export class DesktopIpc extends EventEmitter {
  constructor({ transport = windowsTransport, timeoutMs = 15_000 } = {}) {
    super(); this.transportFactory = transport; this.timeoutMs = timeoutMs; this.pending = new Map();
    this.id = 'initializing-client'; this.header = Buffer.alloc(4); this.headerBytes = 0; this.bodyBytes = 0;
    this.state = null; this.revision = null; this.hydrating = true; this.frames = []; this.frameBytes = 0;
  }
  async open(threadId) {
    this.threadId = threadId; this.transport = this.transportFactory();
    const fail = () => this.fail(desktopError('无法连接电脑 Codex，请确认桌面软件仍在运行'));
    this.transport.input.on('data', chunk => this.receive(chunk));
    this.transport.input.on('error', fail); this.transport.input.on('end', fail);
    this.transport.output.on('error', fail); this.transport.child?.on('error', fail); this.transport.child?.on('exit', fail);
    const init = await this.request('initialize', 0, { clientType: 'codexlink-desktop-follower' });
    if (!init.result?.clientId || init.handledByClientId !== init.result.clientId) throw invalid();
    this.id = init.result.clientId;
    const owner = await this.request('thread-owner-discovery', 1, { hostId: 'local', conversationId: threadId });
    if (!owner.handledByClientId || owner.handledByClientId === this.id || owner.result?.supportsUntrustedAppInput !== true) throw invalid();
    this.owner = owner.handledByClientId;
    this.write({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: this.id,
      targetClientIds: [this.owner], params: { hostId: 'local', conversationId: threadId, following: true } });
    const reply = await this.request('thread-follower-load-complete-history', 1, { conversationId: threadId });
    const revision = reply.result?.revision;
    if (!Number.isSafeInteger(revision)) throw invalid();
    await this.anchor(revision);
    return this;
  }
  async anchor(revision) {
    const deadline = Date.now() + this.timeoutMs;
    while (!this.failure) {
      const index = this.frames.findIndex(f => f.change.type === 'snapshot' && f.change.revision === revision);
      if (index >= 0) {
        const frame = this.frames[index]; this.state = frame.change.conversationState; this.revision = revision;
        this.checkState(); const later = this.frames.slice(index + 1); this.frames = []; this.frameBytes = 0; this.hydrating = false;
        for (const value of later) this.change(value.change);
        this.emit('state', this.state); return;
      }
      if (Date.now() >= deadline) throw invalid();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw this.failure;
  }
  checkState() { if (!record(this.state) || this.state.id !== this.threadId || !Array.isArray(this.state.requests)) throw invalid(); }
  request(method, version, params, { mutation = false } = {}) {
    if (this.failure || this.closed) return Promise.reject(this.failure || invalid());
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const uncertain = () => desktopError('发送结果尚未确认，请刷新对话核对，不要重复发送', 'RPC_TIMEOUT', 503);
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(mutation ? uncertain() : invalid()); }, this.timeoutMs + 500);
      this.pending.set(requestId, { resolve, reject, timer, method, mutation, uncertain, owner: this.owner });
      try { this.write({ type: 'request', requestId, sourceClientId: this.id, method, version, params,
        ...(this.owner ? { targetClientId: this.owner } : {}), timeoutMs: this.timeoutMs }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  write(message) {
    if (this.failure || this.closed) throw this.failure || invalid();
    const body = Buffer.from(JSON.stringify(message));
    if (!body.length || body.length > MAX_FRAME) throw invalid();
    const head = Buffer.alloc(4); head.writeUInt32LE(body.length); this.transport.output.write(Buffer.concat([head, body]));
  }
  receive(chunk) {
    try {
      let offset = 0;
      while (offset < chunk.length && !this.failure && !this.closed) {
        if (!this.body) {
          const n = Math.min(4 - this.headerBytes, chunk.length - offset); chunk.copy(this.header, this.headerBytes, offset, offset + n);
          offset += n; this.headerBytes += n; if (this.headerBytes < 4) return;
          const size = this.header.readUInt32LE(0); if (!size || size > MAX_FRAME) throw invalid();
          this.body = Buffer.allocUnsafe(size); this.headerBytes = 0; this.bodyBytes = 0;
        }
        const n = Math.min(this.body.length - this.bodyBytes, chunk.length - offset); chunk.copy(this.body, this.bodyBytes, offset, offset + n);
        offset += n; this.bodyBytes += n; if (this.bodyBytes < this.body.length) return;
        const bytes = this.body; this.body = null; this.bodyBytes = 0;
        const message = JSON.parse(bytes.toString('utf8')); if (!record(message)) throw invalid(); this.message(message, bytes.length);
      }
    } catch { this.fail(invalid()); }
  }
  message(m, bytes) {
    if (m.type === 'client-discovery-request') { this.write({ type: 'client-discovery-response', requestId: m.requestId, response: { canHandle: false } }); return; }
    if (m.type === 'request') { this.write({ type: 'response', requestId: m.requestId, resultType: 'error', error: 'no-handler-for-request' }); return; }
    if (m.type === 'response') {
      const p = this.pending.get(m.requestId); if (!p) return;
      this.pending.delete(m.requestId); clearTimeout(p.timer);
      if (m.resultType !== 'success' || m.method !== p.method || (p.owner && m.handledByClientId !== p.owner)) {
        p.reject(p.mutation ? p.uncertain() : desktopError('电脑会话暂不可用，请在电脑 Codex 中打开该任务后重试')); return;
      }
      p.resolve(m); return;
    }
    if (m.type !== 'broadcast') return;
    if (m.method === 'ipc-connection-reset' || (m.method === 'client-status-changed' && m.params?.status === 'disconnected' && m.params?.clientId === this.owner)) {
      this.fail(desktopError('电脑 Codex 连接已断开，请刷新任务后继续')); return;
    }
    if (m.method !== 'thread-stream-state-changed' || m.params?.conversationId !== this.threadId) return;
    if (m.sourceClientId !== this.owner || m.version !== 11 || m.params.hostId !== 'local') throw invalid();
    const change = m.params.change;
    if (!record(change) || !Number.isSafeInteger(change.revision) || change.revision < 0) throw invalid();
    if (this.hydrating) { this.frameBytes += bytes; if (this.frameBytes > MAX_FRAME) throw invalid(); this.frames.push({ change }); }
    else this.change(change);
  }
  change(change) {
    if (change.revision < this.revision) return;
    if (change.revision === this.revision) {
      if (change.type === 'snapshot' && !isDeepStrictEqual(change.conversationState, this.state)) throw invalid(); return;
    }
    if (change.revision !== this.revision + 1) throw invalid();
    if (change.type === 'snapshot') this.state = change.conversationState;
    else if (change.type === 'patches' && Array.isArray(change.patches)) this.state = patchState(this.state, change.patches);
    else throw invalid();
    this.revision = change.revision; this.checkState(); this.emit('state', this.state);
  }
  fail(error) {
    if (this.failure || this.closed) return; this.failure = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(p.mutation ? p.uncertain() : error); }
    this.pending.clear(); this.transport?.close(); this.emit('disconnected', error);
  }
  close() {
    if (this.closed) return; this.fail(desktopError('桌面协同连接已关闭')); this.closed = true;
  }
}

export function patchState(state, patches) {
  // Only JSON object/array patches from a verified owner. Never follow prototype properties.
  for (const patch of patches) {
    const keys = patch?.path;
    if (!Array.isArray(keys) || !['add', 'replace', 'remove'].includes(patch.op) || keys.some(k => !['string', 'number'].includes(typeof k) || ['__proto__', 'constructor', 'prototype'].includes(String(k)))) throw invalid();
    if (!keys.length) { if (patch.op === 'remove') throw invalid(); state = patch.value; continue; }
    let parent = state;
    for (const key of keys.slice(0, -1)) { if (!parent || !Object.hasOwn(parent, key)) throw invalid(); parent = parent[key]; }
    if (!parent || typeof parent !== 'object') throw invalid();
    const key = keys.at(-1);
    if (Array.isArray(parent)) {
      if (!Number.isSafeInteger(key) || key < 0 || key > parent.length || (patch.op !== 'add' && key >= parent.length)) throw invalid();
      if (patch.op === 'add') parent.splice(key, 0, patch.value); else if (patch.op === 'remove') parent.splice(key, 1); else parent[key] = patch.value;
    } else {
      if (patch.op !== 'add' && !Object.hasOwn(parent, key)) throw invalid();
      if (patch.op === 'remove') delete parent[key]; else parent[key] = patch.value;
    }
  }
  return state;
}
