import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { acquireLock } from './runtime-lock.mjs';
import { ProjectStorage } from './project-storage.mjs';
import { PasswordVault } from './password-vault.mjs';

const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
export const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw failure('名称应为 1–80 个字符');
  return value.trim();
}
export function level(value) {
  if (!Number.isInteger(value) || value < 0 || value > 9) throw failure('等级应为 0–9 的整数');
  return value;
}
function username(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{3,40}$/.test(value)) throw failure('账号须为 3–40 位字母、数字、下划线或短横线');
  return value.toLowerCase();
}
async function passwordHash(value, salt = randomBytes(16).toString('hex')) {
  if (typeof value !== 'string' || value.length < 6 || value.length > 128) throw failure('密码长度应为 6–128 位');
  return { salt, hash: (await derive(value, salt, 64)).toString('hex') };
}
export function publicUser(user) {
  const { id, username, role, level, disabled } = user;
  return { id, username, role, level, disabled };
}

export class AccessStore extends EventEmitter {
  constructor(root) {
    super(); this.root = root; this.queue = Promise.resolve(); this.sessions = new Map(); this.attempts = new Map();
    this.removingProjects = new Set(); // Blocks execution while removal is being committed.
    this.data = { version: 1, revision: 0, users: [], projects: [], bindings: [] };
  }
  async start() {
    await mkdir(this.root, { recursive: true });
    this.releaseLock = await acquireLock(path.join(this.root, 'access.lock'));
    this.storage = await ProjectStorage.load(this.root);
    try {
      this.data = JSON.parse(await readFile(path.join(this.root, 'access.json'), 'utf8'));
      if (this.data.version !== 1 || !['users', 'projects', 'bindings'].every(key => Array.isArray(this.data[key]))) {
        throw failure('账号项目记录格式不支持');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.passwordVault = new PasswordVault();
    await this.passwordVault.start(this.root, this.data.users.some(user => user.passwordDisplay));
    if (!this.data.users.length) {
      const file = path.join(this.root, 'setup-code.txt');
      try { this.setupCode = (await readFile(file, 'utf8')).trim(); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.setupCode = randomBytes(24).toString('base64url');
        await writeFile(file, this.setupCode, { flag: 'wx', mode: 0o600 });
      }
    }
  }
  exclusive(change) {
    const operation = this.queue.then(change);
    this.queue = operation.catch(() => {}); return operation;
  }
  transaction(change, permissions = false) {
    return this.exclusive(async () => {
      const draft = structuredClone(this.data);
      const result = await change(draft);
      draft.revision++;
      const file = path.join(this.root, 'access.json');
      await writeFile(file + '.tmp', JSON.stringify(draft, null, 2), { mode: 0o600 });
      await rename(file + '.tmp', file);
      this.data = draft;
      if (permissions) this.emit('permissions');
      this.emit('changed');
      return result;
    });
  }
  current(id, data = this.data) {
    const user = data.users.find(user => user.id === id && !user.disabled);
    if (!user) throw failure('请重新登录', 401);
    return user;
  }
  admin(id, data = this.data) {
    const user = this.current(id, data);
    if (user.role !== 'admin') throw failure('需要管理员权限', 403);
    return user;
  }
  canRead(id, project, data = this.data) {
    const user = data.users.find(user => user.id === id && !user.disabled);
    return Boolean(user && project && (project.ownerId === id || (project.shared && user.level >= project.level)));
  }
  project(id, projectId, data = this.data) {
    this.current(id, data);
    const project = data.projects.find(project => project.id === projectId);
    if (!this.canRead(id, project, data)) throw failure('项目不存在或无权访问', 404);
    return project;
  }
  binding(id, taskId) {
    const binding = this.data.bindings.find(task => task.id === taskId);
    if (!binding) throw failure('任务不存在或无权访问', 404);
    const project = this.project(id, binding.projectId);
    return { binding, project };
  }
  throttle(key) {
    const now = Date.now();
    for (const [k, v] of this.attempts) if (v.until < now) this.attempts.delete(k);
    const entry = this.attempts.get(key) || { count: 0, until: now + 300_000 };
    if (entry.count >= 8 || this.attempts.size > 1000) throw failure('尝试过于频繁，请稍后再试', 429);
    entry.count++; this.attempts.set(key, entry);
  }
  async setup(input, legacyTasks = []) {
    this.throttle('setup');
    if (typeof input.code !== 'string' || !this.setupCode || digest(input.code) !== digest(this.setupCode)) throw failure('设置码无效', 403);
    const user = await this.transaction(async data => {
      if (data.users.length) throw failure('管理员已经设置，请登录', 409);
      const user = { id: randomUUID(), username: username(input.username), password: await passwordHash(input.password), role: 'admin', level: 9, disabled: false };
      user.passwordDisplay = this.passwordVault.seal(input.password, user.id, user.password.hash);
      data.users.push(user);
      for (const task of legacyTasks) {
        const project = { id: randomUUID(), name: task.name, source: 'mobile', ownerId: user.id,
          level: 0, shared: false, cwd: task.cwd, createdAt: task.createdAt };
        data.projects.push(project);
        data.bindings.push({ id: task.id, threadId: task.id, projectId: project.id, name: task.name, createdAt: task.createdAt });
      }
      return publicUser(user);
    }, true);
    this.setupCode = null;
    await unlink(path.join(this.root, 'setup-code.txt')).catch(error => { if (error.code !== 'ENOENT') this.emit('cleanupError', error); });
    return this.newSession(user.id);
  }
  async login(input) {
    const account = username(input.username);
    this.throttle('login:' + account);
    const user = this.data.users.find(user => user.username === account);
    const calculated = await passwordHash(input.password, user?.password.salt || '00000000000000000000000000000000');
    if (!user || user.disabled || !timingSafeEqual(Buffer.from(calculated.hash, 'hex'), Buffer.from(user.password.hash, 'hex'))) {
      throw failure('账号或密码错误', 401);
    }
    if (this.current(user.id).password.hash !== user.password.hash) throw failure('账号信息已更新，请重新登录', 401);
    this.attempts.delete('login:' + account);
    return this.newSession(user.id);
  }
  newSession(userId) {
    const now = Date.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(digest(token), { userId, expiresAt: now + 8 * 60 * 60 * 1000 });
    return { token, user: publicUser(this.current(userId)) };
  }
  session(token) {
    const session = typeof token === 'string' ? this.sessions.get(digest(token)) : null;
    if (!session || session.expiresAt <= Date.now()) throw failure('请登录后继续', 401);
    return this.current(session.userId);
  }
  logout(token) { this.sessions.delete(digest(token)); this.emit('permissions'); }
  users(id) { this.admin(id); return this.data.users.map(user => ({ ...publicUser(user), passwordAvailable: Boolean(user.passwordDisplay) })); }
  viewPassword(id, userId, input) {
    this.admin(id);
    if (Object.keys(input).length) throw failure('查看密码不接受额外参数');
    const user = this.data.users.find(user => user.id === userId);
    if (!user) throw failure('账号不存在', 404);
    if (!user.passwordDisplay) throw failure('该账号未保存可查看的密码，请先重新设置密码', 409);
    return { password: this.passwordVault.open(user.passwordDisplay, user.id, user.password.hash) };
  }
  resetPassword(id, userId, input, authorize = () => {}) {
    return this.transaction(async data => {
      authorize(); this.admin(id, data);
      if (Object.keys(input).some(key => key !== 'password')) throw failure('不支持的密码设置参数');
      if (id === userId) throw failure('请通过“修改我的密码”修改当前管理员的密码');
      const user = data.users.find(user => user.id === userId);
      if (!user) throw failure('账号不存在', 404);
      user.password = await passwordHash(input.password);
      authorize();
      user.passwordDisplay = this.passwordVault.seal(input.password, user.id, user.password.hash);
      return { changed: true };
    }, true).then(result => {
      for (const [key, session] of this.sessions) if (session.userId === userId) this.sessions.delete(key);
      this.emit('permissions'); return result;
    });
  }
  createUser(id, input) {
    return this.transaction(async data => {
      this.admin(id, data);
      const account = username(input.username);
      if (data.users.some(user => user.username === account)) throw failure('该账号已存在', 409);
      if (!['admin', 'member'].includes(input.role ?? 'member')) throw failure('角色无效');
      const user = { id: randomUUID(), username: account, password: await passwordHash(input.password),
        role: input.role ?? 'member', level: level(input.level ?? 0), disabled: false };
      user.passwordDisplay = this.passwordVault.seal(input.password, user.id, user.password.hash);
      data.users.push(user); return publicUser(user);
    });
  }
  updateUser(id, userId, input) {
    return this.transaction(async data => {
      this.admin(id, data);
      if (Object.keys(input).some(key => !['level', 'disabled', 'role'].includes(key))) throw failure('不支持修改此账号字段');
      const user = data.users.find(user => user.id === userId);
      if (!user) throw failure('账号不存在', 404);
      if ('level' in input) user.level = level(input.level);
      if ('disabled' in input) {
        if (typeof input.disabled !== 'boolean' || (id === userId && input.disabled)) throw failure('不能停用当前管理员');
        user.disabled = input.disabled;
      }
      if ('role' in input) {
        if (!['admin', 'member'].includes(input.role) || (id === userId && input.role !== 'admin')) throw failure('不能降级当前管理员角色');
        user.role = input.role;
      }
      return publicUser(user);
    }, true).then(user => {
      for (const [key, session] of this.sessions) if (session.userId === userId) this.sessions.delete(key);
      this.emit('permissions'); return user;
    });
  }
  async changePassword(id, input) {
    return this.transaction(async data => {
      const user = this.current(id, data);
      const old = await passwordHash(input.currentPassword, user.password.salt);
      if (!timingSafeEqual(Buffer.from(old.hash, 'hex'), Buffer.from(user.password.hash, 'hex'))) throw failure('原密码错误', 403);
      user.password = await passwordHash(input.password);
      user.passwordDisplay = this.passwordVault.seal(input.password, user.id, user.password.hash);
      return { changed: true };
    }, true).then(result => {
      for (const [key, session] of this.sessions) if (session.userId === id) this.sessions.delete(key);
      this.emit('permissions'); return result;
    });
  }
  async close() { await this.queue; this.sessions.clear(); this.passwordVault?.close(); await this.releaseLock?.(); this.releaseLock = null; }
}
