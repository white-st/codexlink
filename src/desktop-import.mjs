import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { failure, level } from './access-store.mjs';
import { isWithin } from './files.mjs';

// Invoked by a trusted local CLI only. Never expose arbitrary import/cwd to web accounts.
export async function importDesktop(access, client, { username, threadId, projectLevel = 0 }) {
  if (typeof threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(threadId)) throw failure('任务编号无效');
  level(projectLevel);
  const owner = access.data.users.find(u => u.username === username && !u.disabled);
  if (!owner) throw failure('指定账号不存在或已停用');
  const { thread } = await client.request('thread/read', { threadId, includeTurns: false });
  if (thread.id !== threadId || typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd)) throw failure('任务的项目目录无效');
  const cwd = await realpath(thread.cwd);
  if (!(await stat(cwd)).isDirectory()) throw failure('项目目录不存在');
  if (await access.storage.overlaps(cwd)) throw failure('电脑项目不能包含或使用本软件的手机项目目录');
  return access.transaction(data => {
    access.current(owner.id, data);
    if (data.bindings.some(b => b.threadId === threadId)) throw failure('该任务已登记', 409);
    let project = data.projects.find(p => path.relative(p.cwd, cwd) === '');
    if (project && (project.ownerId !== owner.id || project.source !== 'desktop')) throw failure('此目录已属于其他项目，不可重复分配');
    if (data.projects.some(p => p !== project && (isWithin(p.cwd, cwd) || isWithin(cwd, p.cwd)))) {
      throw failure('此目录与已登记项目重叠，不能建立独立的项目权限边界');
    }
    if (!project) {
      project = { id: randomUUID(), name: path.basename(cwd) || '电脑项目', cwd, source: 'desktop', ownerId: owner.id,
        level: projectLevel, shared: false, createdAt: new Date().toISOString() };
      data.projects.push(project);
    }
    data.bindings.push({ id: threadId, threadId, projectId: project.id, name: thread.name || '电脑任务', createdAt: new Date().toISOString() });
    return { projectId: project.id, taskId: threadId, source: 'desktop', shared: project.shared };
  });
}
