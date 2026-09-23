import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// Own this child only; never start, restart, or stop the desktop application's daemon.
export class CodexClient extends EventEmitter {
  constructor({ executable = process.env.CODEX_BIN || 'codex', cwd = process.cwd(), timeoutMs = 30_000, args = ['app-server', '--stdio'], env } = {}) {
    super();
    this.options = { executable, cwd, timeoutMs, args, env };
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
  }

  async start() {
    const { executable, cwd, args, env } = this.options;
    this.child = spawn(executable, args, {
      cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex 连接已关闭 (${code ?? signal})`)));
    this.child.stdin.on('error', error => this.fail(error));
    this.reader = createInterface({ input: this.child.stdout });
    this.reader.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('Codex 返回了无效的协议消息')); return; }
      if ('method' in message) {
        this.emit('message', message);
      } else if ('id' in message) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const error = new Error(message.error.message);
          error.code = message.error.code;
          pending.reject(error);
        } else pending.resolve(message.result);
      }
    });
    // Diagnostics stay in memory and are never sent to the browser or written with credentials.
    this.diagnostics = '';
    this.child.stderr.on('data', chunk => {
      this.diagnostics = (this.diagnostics + chunk.toString()).slice(-12_000);
    });
    try {
      this.info = await this.request('initialize', {
        clientInfo: { name: 'remote_workbench_probe', title: '本机接入验证', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
      this.ready = true;
      return this.info;
    } catch (error) { this.close(); throw error; }
  }

  fail(error) {
    this.ready = false;
    this.failure = error;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer); reject(error);
    }
    this.pending.clear();
    this.emit('disconnected', error);
  }

  send(message) {
    if (!this.child || this.child.stdin.destroyed || this.failure) throw this.failure || new Error('Codex 未连接');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex 请求超时：${method}；执行结果未知，请先查看任务状态，勿重复提交。`);
        error.code = 'RPC_TIMEOUT';
        reject(error);
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) { this.send({ method, params }); }
  respond(id, result) { this.send({ id, result }); }
  rejectRequest(id, message) { this.send({ id, error: { code: -32601, message } }); }

  async closeAndWait() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) { this.close(); return; }
    const exited = new Promise((resolve, reject) => {
      const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 2000);
      const timer = setTimeout(() => { clearTimeout(force); child.off('exit', done); reject(new Error('任务连接尚未确认关闭，请重试交接')); }, 10_000);
      const done = () => { clearTimeout(timer); clearTimeout(force); resolve(); };
      child.once('exit', done);
    });
    if (!child.stdin.destroyed) child.stdin.end();
    await exited;
    this.close();
  }

  close() {
    this.ready = false;
    this.reader?.close();
    this.child?.stdin.end();
    // Only the app-server child created by this client is terminated.
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.fail(new Error('本机连接已停止'));
  }
}
