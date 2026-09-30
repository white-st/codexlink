import { randomUUID } from 'node:crypto';
import { failure, name, level, publicUser } from './access-store.mjs';
import { listFiles, readArtifact } from './files.mjs';
import { saveAttachment, attachmentInput } from './attachments.mjs';
import { skillDefinition } from './skills.mjs';

export const execution = Object.freeze({ enabled: true, mode: 'account-permissions',
  reason: '文件与任务按账号和共享等级展示；Codex 使用本机执行环境。' });
export class Portal {
  constructor(workbench, access) { this.workbench = workbench; this.access = access; }
  projectView(id, project) {
    return { id: project.id, name: project.name, source: project.source, ownerId: project.ownerId,
      level: project.level, shared: project.shared, owned: project.ownerId === id, createdAt: project.createdAt };
  }
  projects(id, source, query = '') {
    this.access.current(id);
    return this.access.data.projects.filter(p => this.access.canRead(id, p) && (!source || p.source === source) && p.name.includes(query))
      .map(p => this.projectView(id, p));
  }
  taskView(binding, project, id) {
    const live = this.workbench.tasks.get(binding.threadId);
    return { id: binding.id, name: binding.name, projectId: project.id, projectName: project.name, source: project.source,
      status: live?.status || (binding.threadId ? 'idle' : 'pending'), busy: Boolean(live?.busy),
      activeTurn: live?.activeTurn ?? null, createdAt: binding.createdAt, connectedToCodex: Boolean(binding.threadId),
      control: this.workbench.controlState(binding.threadId),
      desktopAttention: this.workbench.desktopAttention?.has(binding.threadId) || false,
      canExecute: project.ownerId === id && project.source === 'mobile' };
  }
  tasks(id, source) {
    this.access.current(id);
    return this.access.data.bindings.flatMap(binding => {
      const project = this.access.data.projects.find(p => p.id === binding.projectId);
      return this.access.canRead(id, project) && (!source || project.source === source) ? [this.taskView(binding, project, id)] : [];
    });
  }
  status(id) {
    return { user: publicUser(this.access.current(id)), connected: Boolean(this.workbench.connected), signedIn: Boolean(this.workbench.signedIn),
      execution, projects: this.projects(id), tasks: this.tasks(id), questions: this.questions(id) };
  }
  questions(id) {
    return [...(this.workbench.questions?.values() || [])].flatMap(question => {
      const binding = this.access.data.bindings.find(b => b.threadId === question.taskId);
      if (!binding) return [];
      try {
        this.executable(id, binding.id);
        return [{ id: question.id, taskId: binding.id, questions: question.questions }];
      } catch { return []; }
    });
  }
  createProject(id, input) {
    return this.access.transaction(async data => {
      this.access.current(id, data);
      if (Object.keys(input).some(key => !['name', 'level'].includes(key))) throw failure('新项目仅接受名称与预设等级');
      const projectId = randomUUID();
      const project = { id: projectId, name: name(input.name), source: 'mobile', ownerId: id,
        level: level(input.level ?? 0), shared: false, createdAt: new Date().toISOString() };
      project.cwd = await this.access.storage.createDirectory(project);
      data.projects.push(project); return this.projectView(id, project);
    });
  }
  updateProject(id, projectId, input) {
    return this.access.transaction(data => {
      const user = this.access.current(id, data);
      const project = data.projects.find(p => p.id === projectId);
      if (!project) throw failure('项目不存在或无权访问', 404);
      if (Object.keys(input).some(key => !['shared', 'level', 'name'].includes(key)) || !Object.keys(input).length) throw failure('不支持修改此项目字段');
      if (('shared' in input || 'name' in input) && project.ownerId !== id) throw failure('仅所有者可修改名称或共享状态', 403);
      if ('level' in input && user.role !== 'admin') throw failure('项目创建后仅管理员可调整等级', 403);
      if ('shared' in input) {
        if (typeof input.shared !== 'boolean') throw failure('共享状态无效');
        project.shared = input.shared;
      }
      if ('name' in input) project.name = name(input.name);
      if ('level' in input) project.level = level(input.level);
      // Admin metadata authority does not grant access to private project names/content.
      return this.access.canRead(id, project, data) ? this.projectView(id, project) : { id: project.id, level: project.level };
    }, true);
  }
  createTask(id, input, authorize = () => {}) {
    return this.access.transaction(async data => {
      authorize();
      if (Object.keys(input).some(key => !['name', 'projectId'].includes(key))) throw failure('任务参数无效');
      const project = this.access.project(id, input.projectId, data);
      if (project.ownerId !== id || project.source !== 'mobile') throw failure('只能在自己的手机项目中创建任务', 403);
      const title = name(input.name);
      const task = await this.workbench.createTask(title, { cwd: project.cwd });
      const binding = { id: task.id, projectId: project.id, threadId: task.id, name: title, createdAt: task.createdAt };
      data.bindings.push(binding); return this.taskView(binding, project, id);
    });
  }
  async removeProject(id, projectId, input, authorize = () => {}) {
    let reserved = false;
    try {
      return await this.access.transaction(data => {
        authorize();
        const project = this.access.project(id, projectId, data);
        if (project.ownerId !== id) throw failure('只有项目所有者可以删除项目', 403);
        if (Object.keys(input).some(key => key !== 'confirmName') || input.confirmName !== project.name) {
          throw failure('项目名称已变化或未确认，请刷新后重新确认删除', 409);
        }
        const bindings = data.bindings.filter(b => b.projectId === projectId);
        for (const binding of bindings) {
          const live = this.workbench.tasks.get(binding.threadId);
          const question = [...(this.workbench.questions?.values() || [])].some(q => q.taskId === binding.threadId);
          if (this.workbench.transitions.has(binding.threadId) || live && (live.busy || live.activeTurn || ['starting', 'running', 'waiting', 'waiting-input', 'unknown'].includes(live.status)) || question) {
            throw failure('项目中有任务正在执行或结果待核实，请先停止或刷新任务状态', 409);
          }
        }
        // Reserve before the first asynchronous write: a concurrent send must not start
        // against the old access snapshot while this transaction is on disk.
        this.access.removingProjects.add(projectId); reserved = true;
        data.bindings = data.bindings.filter(b => b.projectId !== projectId);
        data.projects = data.projects.filter(p => p.id !== projectId);
        return { removed: true, projectId, removedTasks: bindings.length, filesKept: true, codexHistoryKept: true };
      }, true);
    } finally {
      if (reserved) this.access.removingProjects.delete(projectId);
    }
  }
  async history(id, taskId) {
    const { binding } = this.access.binding(id, taskId);
    const thread = binding.threadId ? await this.workbench.readThread(binding.threadId) : { id: taskId, turns: [], status: { type: 'idle' } };
    this.access.binding(id, taskId);
    // Do not return host paths or unrelated internal thread metadata.
    return { id: taskId, turns: thread.turns || [], status: thread.status };
  }
  async files(id, taskId) {
    const { project } = this.access.binding(id, taskId);
    const files = await listFiles(project.cwd);
    this.access.binding(id, taskId); return files;
  }
  async file(id, taskId, filename) {
    const { project } = this.access.binding(id, taskId);
    const data = await readArtifact(project.cwd, filename);
    this.access.binding(id, taskId); return data;
  }
  executable(id, taskId) {
    const { binding, project } = this.access.binding(id, taskId);
    if (this.access.removingProjects.has(project.id)) throw failure('项目正在删除，请刷新后继续', 409);
    if (project.ownerId !== id) throw failure('共享项目当前仅可查看', 403);
    if (project.source !== 'mobile') throw failure('已登记的电脑任务当前仅可查看', 403);
    return { binding, project };
  }
  upload(id, taskId, filename, bytes, authorize = () => {}) {
    const finish = this.beginUpload(id, taskId, authorize);
    return this.access.exclusive(async () => {
      const check = () => { authorize(); return this.executable(id, taskId); };
      const { project } = check();
      await this.access.storage.assertTaskDirectory(project.cwd); check();
      return saveAttachment(project.cwd, filename, bytes, check);
    }).finally(finish);
  }
  beginUpload(id, taskId, authorize = () => {}) {
    authorize(); const { binding } = this.executable(id, taskId);
    return this.workbench.beginUpload(binding.threadId || binding.id);
  }
  transfer(id, taskId, input, authorize = () => {}) {
    if (Object.keys(input).some(key => key !== 'target') || !['mobile', 'desktop'].includes(input.target)) throw failure('交接参数无效');
    return this.access.exclusive(async () => {
      const check = () => { authorize(); return this.executable(id, taskId); };
      const { binding } = check();
      if (!binding.threadId) throw failure('请先在手机完成一次对话，再交给电脑', 409);
      const result = await this.workbench.transfer(binding.threadId, input.target, { authorize: check });
      const current = check();
      return { ...result, task: this.taskView(current.binding, current.project, id) };
    });
  }
  async skills(id, taskId, authorize = () => {}) {
    const { project } = this.executable(id, taskId); authorize();
    const skills = await this.workbench.skills(project.cwd);
    authorize(); this.executable(id, taskId);
    return { skills };
  }
  async send(id, taskId, input, authorize = () => {}) {
    if (Object.keys(input).some(key => !['prompt', 'attachments', 'skillId'].includes(key)) || typeof input.prompt !== 'string' || input.prompt.length > 12_000) throw failure('需求应不超过 12000 个字符');
    let { binding, project } = this.executable(id, taskId); authorize();
    skillDefinition(input.skillId);
    this.workbench.assertMobile(binding.threadId || binding.id);
    const { prompt, images } = await attachmentInput(project.cwd, input.prompt, input.attachments);
    if (!prompt.trim()) throw failure('请填写需求或添加附件');
    if (!binding.threadId) {
      // Upgrade an existing pending task in place. Serialize so concurrent sends cannot create two threads.
      await this.access.transaction(async data => {
        authorize();
        const item = data.bindings.find(b => b.id === taskId);
        if (!item) throw failure('任务不存在或无权访问', 404);
        const project = this.access.project(id, item.projectId, data);
        if (!item.threadId) item.threadId = (await this.workbench.createTask(item.name, { cwd: project.cwd })).id;
      });
      ({ binding } = this.executable(id, taskId));
    }
    const check = () => { authorize(); this.executable(id, taskId); };
    check();
    const result = await this.workbench.send(binding.threadId, prompt, { authorize: check, skillId: input.skillId, images });
    const current = this.executable(id, taskId);
    return { turnId: result.turnId, task: this.taskView(current.binding, current.project, id) };
  }
  stop(id, taskId) {
    const { binding } = this.executable(id, taskId);
    this.workbench.assertMobile(binding.threadId);
    if (!binding.threadId) throw failure('任务尚未开始', 409);
    return this.workbench.stop(binding.threadId);
  }
  answer(id, taskId, input) {
    const { binding } = this.executable(id, taskId);
    this.workbench.assertMobile(binding.threadId);
    if (!binding.threadId) throw failure('任务尚未开始', 409);
    if (Object.keys(input).some(key => !['requestId', 'answers'].includes(key))) throw failure('回答参数无效');
    return this.workbench.answer(binding.threadId, input.requestId, input.answers);
  }
  async reconcile(id, taskId) {
    let { binding } = this.access.binding(id, taskId);
    if (binding.threadId && this.workbench.tasks.has(binding.threadId)) await this.workbench.reconcile(binding.threadId);
    const thread = await this.history(id, taskId);
    const current = this.access.binding(id, taskId);
    return { thread, task: this.taskView(current.binding, current.project, id) };
  }
  event(id, event) {
    try {
      const taskId = event.data.taskId || (event.type === 'task' ? event.data.id : null);
      if (!taskId) return null;
      const match = this.access.data.bindings.find(b => b.threadId === taskId);
      if (!match) return null;
      const { binding, project } = this.access.binding(id, match.id);
      // Browser retrieves authorized history; never broadcast arbitrary upstream payloads.
      return { type: 'task-changed', data: { taskId: binding.id, projectId: project.id } };
    } catch { return null; }
  }
}
