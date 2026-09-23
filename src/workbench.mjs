import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexSessions } from './codex-sessions.mjs';
import { listFiles, readArtifact } from './files.mjs';
import { acquireLock } from './runtime-lock.mjs';
import { ProjectStorage } from './project-storage.mjs';
import { listSkills, skillDefinition, skillInput } from './skills.mjs';

export class Workbench extends EventEmitter {
  constructor({ root = path.resolve('.runtime'), client = new CodexSessions() } = {}) {
    super();
    this.root = root;
    this.storage = new ProjectStorage(root);
    this.client = client;
    this.tasks = new Map();
    this.loaded = new Set();
    this.transitions = new Set();
    this.uploads = new Map();
    this.questions = new Map();
    this.events = [];
    this.sequence = 0;
    this.writeQueue = Promise.resolve();
    client.on('message', message => this.onMessage(message));
    client.on('threadDisconnected', ({ threadId, error }) => {
      this.loaded.delete(threadId);
      const task = this.tasks.get(threadId);
      if (task?.busy) { task.status = 'unknown'; task.error = '任务连接断开，请刷新执行结果'; }
      for (const [key, question] of this.questions) if (question.taskId === threadId) this.questions.delete(key);
      this.emitEvent('notice', { taskId: threadId, message: error.message });
    });
    client.on('disconnected', error => {
      this.connected = false;
      this.loaded.clear();
      for (const task of this.tasks.values()) if (task.busy) {
        task.status = 'unknown';
        task.error = '连接断开，执行结果待核实';
      }
      this.emitEvent('connection', { connected: false, message: error.message });
    });
  }

  async start() {
    await mkdir(path.join(this.root, 'workspaces'), { recursive: true });
    this.releaseLock = await acquireLock(path.join(this.root, 'workbench.lock'));
    this.storage = await ProjectStorage.load(this.root);
    try {
      const data = JSON.parse(await readFile(path.join(this.root, 'registry.json'), 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error('任务登记文件格式不支持');
      for (const task of data.tasks) {
        await this.storage.assertTaskDirectory(task.cwd);
        this.tasks.set(task.id, task);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.client.start();
    const account = await this.client.request('account/read', { refreshToken: false });
    const models = await this.client.request('model/list', {});
    this.connected = true;
    this.signedIn = Boolean(account.account);
    this.model = models.data.find(model => model.isDefault)?.id || null;
    return this.status();
  }

  status() {
    return { connected: Boolean(this.connected), signedIn: Boolean(this.signedIn), model: this.model,
      mode: 'trusted-local-prototype', tasks: [...this.tasks.values()], lastEventId: this.sequence };
  }

  persist() {
    const data = JSON.stringify({ version: 1, tasks: [...this.tasks.values()] }, null, 2);
    const file = path.join(this.root, 'registry.json');
    const operation = this.writeQueue.then(async () => {
      await writeFile(file + '.tmp', data);
      await rename(file + '.tmp', file);
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  emitEvent(type, data) {
    const event = { id: ++this.sequence, type, data, at: new Date().toISOString() };
    this.events.push(event);
    if (this.events.length > 1500) this.events.shift();
    this.emit('event', event);
    return event;
  }

  onMessage(message) {
    const params = message.params || {};
    const task = this.tasks.get(params.threadId || params.thread?.id);
    if ('id' in message) {
      if (task && message.method === 'item/tool/requestUserInput') {
        this.questions.set(String(message.id), { id: message.id, taskId: task.id, questions: params.questions });
        task.status = 'waiting';
        this.emitEvent('question', this.questions.get(String(message.id)));
      } else if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
        this.client.respond(message.id, { decision: 'decline' });
        this.emitEvent('notice', { taskId: task?.id, message: '已拒绝超出当前权限的操作申请；验证版不自动扩大权限。' });
      } else if (message.method === 'item/permissions/requestApproval') {
        this.client.respond(message.id, { permissions: {}, scope: 'turn' });
      } else this.client.rejectRequest(message.id, `验证版暂不支持请求：${message.method}`);
      return;
    }
    if (!task) return;
    if (message.method === 'thread/closed') this.loaded.delete(task.id);
    if (message.method === 'turn/started') {
      task.activeTurn = params.turn.id;
      task.status = 'running';
      task.busy = true;
    }
    if (message.method === 'turn/completed') {
      task.activeTurn = null;
      task.status = params.turn.status;
      task.busy = false;
      task.error = params.turn.error?.message || null;
      for (const [key, question] of this.questions) if (question.taskId === task.id) this.questions.delete(key);
    }
    if (message.method === 'serverRequest/resolved') this.questions.delete(String(params.requestId));
    if (message.method === 'error') task.error = params.error?.message || params.message || 'Codex 执行错误';
    if (['turn/started', 'turn/completed', 'error'].includes(message.method)) {
      void this.persist().catch(error => this.emitEvent('notice', { taskId: task.id, message: `保存状态失败：${error.message}` }));
    }
    this.emitEvent('codex', { taskId: task.id, method: message.method, params });
  }

  task(id) {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error('只能操作本验证工具创建的任务'), { statusCode: 403 });
    return task;
  }

  controlState(id) {
    if (this.transitions.has(id)) return 'changing';
    const task = this.tasks.get(id);
    const ownsConnection = this.client.hasThread ? this.client.hasThread(id) : this.loaded.has(id);
    return task?.controlTarget === 'desktop' ? (ownsConnection ? 'release-pending' : 'desktop') : 'mobile';
  }
  assertMobile(id) {
    if (this.controlState(id) !== 'mobile') throw Object.assign(new Error('任务已交给电脑或正在交接，请先恢复手机操作'), { statusCode: 409 });
  }
  beginUpload(id) {
    this.assertMobile(id); this.uploads.set(id, (this.uploads.get(id) || 0) + 1);
    let finished = false;
    return () => { if (finished) return; finished = true; const count = this.uploads.get(id) - 1; if (count) this.uploads.set(id, count); else this.uploads.delete(id); };
  }
  async transfer(id, target, { authorize = () => {} } = {}) {
    const task = this.task(id);
    if (target !== 'desktop' && target !== 'mobile') throw Object.assign(new Error('交接目标无效'), { statusCode: 400 });
    if (this.transitions.has(id) || this.uploads.has(id) || task.busy || task.activeTurn || ['starting', 'running', 'waiting', 'waiting-input', 'unknown'].includes(task.status) || [...this.questions.values()].some(q => q.taskId === id)) {
      throw Object.assign(new Error('任务正在执行、上传或结果待核实，请完成后再交接'), { statusCode: 409 });
    }
    authorize(); this.transitions.add(id);
    try {
      if (target === 'desktop') {
        if (task.controlTarget !== 'desktop') {
          let thread;
          try { thread = await this.readThread(id); }
          catch (error) { if (/no rollout|not materialized/i.test(error.message)) throw Object.assign(new Error('请先在手机完成一次对话，再交给电脑'), { statusCode: 409 }); throw error; }
          if (!thread.turns?.length) throw Object.assign(new Error('请先在手机完成一次对话，再交给电脑'), { statusCode: 409 });
        }
        const previous = task.controlTarget; task.controlTarget = 'desktop';
        try { await this.persist(); } catch (error) { task.controlTarget = previous; throw error; }
        authorize();
        await this.client.releaseThread(id); // Resolves only after this task's process exits.
        this.loaded.delete(id);
      } else {
        if (task.controlTarget !== 'desktop') return { target: 'mobile' };
        authorize();
        try { await this.client.request('thread/resume', { threadId: id, cwd: task.cwd,
          sandbox: 'workspace-write', approvalPolicy: 'never', runtimeWorkspaceRoots: [task.cwd] }); }
        catch (error) {
          if (/active writer/i.test(error.message)) throw Object.assign(new Error('电脑仍占用此任务，请在电脑端关闭该会话（必要时退出 Codex）后重试'), { statusCode: 409 });
          throw error;
        }
        this.loaded.add(id);
        try { authorize(); task.controlTarget = 'mobile'; await this.persist(); }
        catch (error) { task.controlTarget = 'desktop'; await this.client.releaseThread(id); this.loaded.delete(id); throw error; }
      }
      task.error = null;
      return { target };
    } finally { this.transitions.delete(id); this.emitEvent('task', task); }
  }

  async createTask(name = '接入测试', { cwd: projectCwd } = {}) {
    if (!this.connected || !this.signedIn) throw new Error('请先在本机 Codex 完成登录并连接');
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('任务名称应为 1–80 个字符');
    const cwd = projectCwd ? path.resolve(projectCwd) : path.join(this.root, 'workspaces', randomUUID());
    if (!this.storage.allows(cwd)) throw new Error('手机任务必须位于已配置的手机项目目录');
    await mkdir(cwd, { recursive: true });
    await this.storage.assertTaskDirectory(cwd);
    const result = await this.client.request('thread/start', {
      cwd, sandbox: 'workspace-write', approvalPolicy: 'never',
      runtimeWorkspaceRoots: [cwd],
      developerInstructions: 'Work on the requested project in the provided working directory. Do not inspect other projects, account credentials, or other conversations. Do not modify global settings. Do not delegate to other agents. Report failures honestly.',
    });
    const task = { id: result.thread.id, name: name.trim(), cwd, source: 'mobile-prototype',
      createdAt: new Date().toISOString(), status: 'idle', busy: false, activeTurn: null };
    this.tasks.set(task.id, task);
    this.loaded.add(task.id);
    await this.persist();
    try { await this.client.request('thread/name/set', { threadId: task.id, name: `手机任务 · ${task.name}` }); }
    catch (error) { this.emitEvent('notice', { taskId: task.id, message: `任务已创建，但桌面标题同步失败：${error.message}` }); }
    this.emitEvent('task', task);
    return task;
  }

  async listDesktop(cursor = null) {
    const result = await this.client.request('thread/list', {
      limit: 30, cursor, useStateDbOnly: true, sortKey: 'updated_at',
      sourceKinds: ['cli', 'vscode', 'appServer', 'exec'],
    });
    return { data: result.data.filter(task => !this.tasks.has(task.id)).map(task => ({
      id: task.id, name: task.name || task.preview || '未命名任务', cwd: task.cwd,
      status: task.status, updatedAt: task.updatedAt,
    })), nextCursor: result.nextCursor };
  }

  async readThread(id) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('任务标识无效');
    const result = await this.client.request('thread/read', { threadId: id, includeTurns: true });
    return result.thread;
  }

  skills(cwd) { return listSkills(this.client, cwd); }

  async send(id, prompt, { authorize = () => {}, skillId } = {}) {
    const task = this.task(id);
    this.assertMobile(id);
    skillDefinition(skillId);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12_000) throw new Error('需求应为 1–12000 个字符');
    if (task.busy) throw Object.assign(new Error('任务正在执行或结果待核实，请先刷新状态'), { statusCode: 409 });
    authorize();
    task.busy = true;
    task.status = 'starting';
    task.error = null;
    try {
      await this.persist();
      authorize();
      if (!this.loaded.has(id)) {
        await this.client.request('thread/resume', { threadId: id, cwd: task.cwd,
          sandbox: 'workspace-write', approvalPolicy: 'never', runtimeWorkspaceRoots: [task.cwd] });
        this.loaded.add(id);
      }
      const input = await skillInput(this.client, task.cwd, skillId, prompt);
      authorize();
      const result = await this.client.request('turn/start', {
        threadId: id, input, cwd: task.cwd,
        approvalPolicy: 'never', runtimeWorkspaceRoots: [task.cwd],
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [task.cwd], networkAccess: false,
          excludeSlashTmp: true, excludeTmpdirEnvVar: true },
      });
      // An event may already have completed the turn before its response arrives.
      // The response can arrive before Codex has an interruptible active turn.
      // Only turn/started assigns activeTurn; do not expose premature stop controls.
      await this.persist();
      return { turnId: result.turn.id, task };
    } catch (error) {
      task.status = error.code === 'RPC_TIMEOUT' || !this.connected || task.status === 'unknown' ? 'unknown' : 'failed';
      task.busy = task.status === 'unknown';
      task.error = error.message;
      await this.persist();
      throw error;
    }
  }

  async reconcile(id) {
    const task = this.task(id);
    const thread = await this.readThread(id);
    const last = thread.turns?.at(-1);
    if (!this.transitions.has(id) && task.status !== 'starting' && thread.status?.type !== 'active' && last &&
        (!task.activeTurn || last.id === task.activeTurn) &&
        ['completed', 'interrupted', 'failed'].includes(last.status)) {
      task.busy = false; task.activeTurn = null; task.status = last.status;
      task.error = last.error?.message || null;
      await this.persist();
    }
    return { task, thread };
  }

  async stop(id) {
    const task = this.task(id);
    if (!task.activeTurn || !this.loaded.has(id)) throw new Error('任务尚未进入可停止的执行状态，请等待开始事件或刷新状态');
    await this.client.request('turn/interrupt', { threadId: id, turnId: task.activeTurn });
    return { requested: true }; // The completion notification determines the final state.
  }

  answer(id, requestId, answers) {
    this.task(id);
    const question = this.questions.get(String(requestId));
    if (!question || question.taskId !== id) throw new Error('该问题已失效');
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('回答格式无效');
    const output = {};
    for (const item of question.questions) {
      const value = answers[item.id];
      if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error('请填写完整回答');
      output[item.id] = { answers: [value] };
    }
    this.client.respond(question.id, { answers: output });
    this.questions.delete(String(requestId));
    this.task(id).status = 'running';
    return { answered: true };
  }

  files(id) { return listFiles(this.task(id).cwd); }
  file(id, name) { return readArtifact(this.task(id).cwd, name); }
  async close() {
    await this.client.close();
    await this.writeQueue;
    await this.releaseLock?.();
    this.releaseLock = null;
  }
}
