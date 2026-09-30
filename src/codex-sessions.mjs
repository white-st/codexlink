import { EventEmitter } from 'node:events';
import { CodexClient } from './codex-client.mjs';
import { DesktopClient } from './desktop-client.mjs';

// One owned process per writable thread. Metadata reads never resume external threads.
export class CodexSessions extends EventEmitter {
  constructor(options = {}) {
    super(); const factory = options.factory || (() => new CodexClient());
    this.desktopFactory = options.desktopFactory === undefined ? (!options.factory && process.platform === 'win32' ? () => new DesktopClient() : null) : options.desktopFactory;
    this.autoReleaseIdle = options.autoReleaseIdle ?? !options.factory;
    this.factory = factory; this.sessions = new Map(); this.requests = new Map();
    this.sequence = 0; this.closed = false;
    this.control = this.attach(factory());
  }
  attach(client) {
    const session = { client, key: ++this.sequence, threadId: null, closing: false };
    client.on('message', message => {
      if (session.closing || this.closed) return;
      if ('id' in message) {
        const id = `${session.key}:${message.id}`;
        this.requests.set(id, { session, original: message.id });
        this.emit('message', { ...message, id });
      } else if (message.method === 'serverRequest/resolved') {
        const id = `${session.key}:${message.params.requestId}`; this.requests.delete(id);
        this.emit('message', { ...message, params: { ...message.params, requestId: id } });
      } else this.emit('message', message);
    });
    client.on('disconnected', error => {
      if (session.closing || this.closed) return;
      this.clearRequests(session);
      if (session === this.control) this.emit('disconnected', error);
      else if (session.threadId) this.emit('threadDisconnected', { threadId: session.threadId, error });
    });
    return session;
  }
  clearRequests(session) { for (const [key, request] of this.requests) if (request.session === session) this.requests.delete(key); }
  hasThread(threadId) { return this.sessions.has(threadId); }
  isDesktopThread(threadId) { return Boolean(this.sessions.get(threadId)?.client.desktop); }
  async start() { return this.control.client.start(); }
  async request(method, params = {}) {
    if (this.closed) throw new Error('连接已关闭');
    if (method === 'thread/start' || method === 'thread/resume') {
      const existing = this.sessions.get(params.threadId);
      if (existing?.client.ready && !existing.closing) return existing.client.request(method, params);
      if (existing) await this.releaseThread(params.threadId);
      const session = this.attach(this.factory());
      if (params.threadId) { session.threadId = params.threadId; this.sessions.set(params.threadId, session); }
      try {
        await session.client.start();
        const result = await session.client.request(method, params);
        session.threadId = result.thread?.id || params.threadId;
        if (!session.threadId) throw new Error('Codex 未返回任务标识');
        if (this.closed) throw new Error('连接已关闭');
        this.sessions.set(session.threadId, session); return result;
      } catch (error) {
        session.closing = true; this.clearRequests(session);
        try { await session.client.closeAndWait(); }
        catch (closeError) { session.closing = false; closeError.code = 'RPC_TIMEOUT'; throw closeError; }
        if (session.threadId) this.sessions.delete(session.threadId);
        // Resume failed before any turn was submitted. Only this known conflict
        // permits handing input to the existing desktop owner; never retry a turn.
        if (method === 'thread/resume' && this.desktopFactory && /already has an active writer/i.test(error.message) && !this.closed) {
          const follower = this.attach(this.desktopFactory());
          follower.threadId = params.threadId; this.sessions.set(params.threadId, follower);
          try { await follower.client.start(); return await follower.client.request(method, params); }
          catch (failure) { await this.releaseThread(params.threadId); throw failure; }
        }
        throw error;
      }
    }
    const session = this.sessions.get(params.threadId);
    if ((method.startsWith('turn/') || method === 'thread/name/set') && !session) throw new Error('任务尚未连接，请恢复手机操作');
    return (session || this.control).client.request(method, params);
  }
  respond(id, result) {
    const request = this.requests.get(String(id)); if (!request) throw new Error('请求已失效');
    request.session.client.respond(request.original, result); this.requests.delete(String(id));
  }
  rejectRequest(id, message) {
    const request = this.requests.get(String(id)); if (!request) return;
    request.session.client.rejectRequest(request.original, message); this.requests.delete(String(id));
  }
  async releaseThread(threadId) {
    const session = this.sessions.get(threadId); if (!session) return;
    session.closing = true;
    try { await session.client.closeAndWait(); }
    catch (error) { session.closing = false; throw error; }
    this.clearRequests(session); this.sessions.delete(threadId);
  }
  async close() {
    this.closed = true;
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.releaseThread(id)));
    await this.control.client.closeAndWait();
    const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
  }
}
