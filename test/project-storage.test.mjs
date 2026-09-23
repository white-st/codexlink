import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { ProjectStorage } from '../src/project-storage.mjs';
import { Workbench } from '../src/workbench.mjs';
import { AccessStore } from '../src/access-store.mjs';
import { Portal } from '../src/portal.mjs';
import { importDesktop } from '../src/desktop-import.mjs';

await mkdir('.runtime/tests', { recursive: true });
const id = '12345678-1234-4234-8234-123456789012';
async function fixture() {
  const base = await mkdtemp(path.resolve('.runtime/tests/storage-'));
  const root = path.join(base, 'runtime'), mobileRoot = path.join(base, 'phone');
  await mkdir(root);
  await writeFile(path.join(root, 'storage.json'), JSON.stringify({ mobileRoot }));
  return { root, mobileRoot, storage: await ProjectStorage.load(root) };
}
class Client extends EventEmitter {
  constructor() { super(); this.calls = []; this.next = 0; }
  async start() {}
  close() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: {} };
    if (method === 'model/list') return { data: [{ id: 'fixture', isDefault: true }] };
    if (method === 'thread/start') return { thread: { id: `native-${++this.next}` } };
    if (method === 'turn/start') return { turn: { id: 'turn' } };
    return {};
  }
}

test('项目按北京时间归档，重名互不覆盖，名字中的路径字符无效化', async () => {
  const f = await fixture();
  const input = { id, name: '../../CON:题目?. ', createdAt: '2026-09-22T16:00:00.000Z' };
  const cwd = await f.storage.createDirectory(input);
  assert.equal(path.dirname(cwd), path.join(f.mobileRoot, '2026-09-23'));
  assert.match(path.basename(cwd), /^000000_.*_12345678$/);
  assert.equal(/[<>:"/\\|?*]/.test(path.basename(cwd)), false);
  await writeFile(path.join(cwd, 'keep.txt'), 'keep');
  await assert.rejects(f.storage.createDirectory(input), { code: 'EEXIST' });
  const other = await f.storage.createDirectory({ ...input, id: '87654321-1234-4234-8234-123456789012' });
  assert.notEqual(cwd, other); assert.equal(await readFile(path.join(cwd, 'keep.txt'), 'utf8'), 'keep');
});

test('目录配置拒绝相对路径和数据根目录，非法配置不会静默退回默认路径', async () => {
  const f = await fixture();
  for (const config of [{ mobileRoot: '../phone' }, { mobileRoot: f.root }, { mobileRoot: path.dirname(f.root) }, { token: 'x' }, null]) {
    assert.throws(() => new ProjectStorage(f.root, config));
  }
  await writeFile(path.join(f.root, 'storage.json'), '{bad');
  await assert.rejects(ProjectStorage.load(f.root));
});

test('手机目录不能通过日期目录链接越界，也不能直接将根目录当项目', async () => {
  const f = await fixture(); const outside = path.join(path.dirname(f.root), 'outside');
  await mkdir(outside); await mkdir(f.mobileRoot);
  await symlink(outside, path.join(f.mobileRoot, '2026-09-22'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.storage.createDirectory({ id, name: 'test', createdAt: '2026-09-22T01:00:00Z' }), /之外/);
  assert.equal(f.storage.allows(f.mobileRoot), false);
  await assert.rejects(f.storage.assertTaskDirectory(path.join(f.mobileRoot, '2026-09-22')), /之外/);
});

test('外部目录项目沿用私有、等级、只读与撤权规则，重启后旧新任务都可继续', async t => {
  const f = await fixture(); const access = new AccessStore(f.root); await access.start();
  const client = new Client(), workbench = new Workbench({ root: f.root, client }); await workbench.start();
  t.after(async () => { await workbench.close(); await access.close(); });
  const owner = await access.setup({ code: access.setupCode, username: 'owner', password: 'storage-test-password' });
  const member = await access.createUser(owner.user.id, { username: 'member', password: 'storage-test-password', level: 1 });
  const portal = new Portal(workbench, access);
  const view = await portal.createProject(owner.user.id, { name: '文件整理', level: 3 });
  const project = access.data.projects.find(p => p.id === view.id);
  assert.ok(project.cwd.startsWith(f.mobileRoot + path.sep)); assert.equal(view.cwd, undefined);
  const task = await portal.createTask(owner.user.id, { projectId: project.id, name: 'test' });
  assert.equal(client.calls.find(c => c.method === 'thread/start').params.cwd, project.cwd);
  await writeFile(path.join(project.cwd, 'result.txt'), 'STORAGE');
  await assert.rejects(portal.file(member.id, task.id, 'result.txt'), /无权/);
  await portal.updateProject(owner.user.id, project.id, { shared: true });
  await assert.rejects(portal.file(member.id, task.id, 'result.txt'), /无权/);
  await access.updateUser(owner.user.id, member.id, { level: 3 });
  assert.equal((await portal.file(member.id, task.id, 'result.txt')).toString(), 'STORAGE');
  await assert.rejects(portal.send(member.id, task.id, { prompt: 'write' }), /仅可查看/);
  await portal.updateProject(owner.user.id, project.id, { shared: false, name: '新名称' });
  assert.equal(access.data.projects[0].cwd, project.cwd);
  await assert.rejects(portal.file(member.id, task.id, 'result.txt'), /无权/);
  await assert.rejects(portal.createProject(owner.user.id, { name: 'bad', cwd: f.mobileRoot }), /仅接受/);

  const legacy = await workbench.createTask('legacy');
  await workbench.close(); await access.close();
  const restored = new Workbench({ root: f.root, client: new Client() });
  const restoredAccess = new AccessStore(f.root); await restoredAccess.start(); await restored.start();
  try {
    assert.equal(restored.tasks.get(task.id).cwd, project.cwd);
    assert.equal(restored.tasks.get(legacy.id).cwd, legacy.cwd);
    await restored.send(task.id, 'continue');
    const resume = restored.client.calls.find(c => c.method === 'thread/resume');
    assert.equal(resume.params.cwd, project.cwd);
    const turn = restored.client.calls.find(c => c.method === 'turn/start');
    assert.deepEqual(turn.params.sandboxPolicy.writableRoots, [project.cwd]);
    assert.equal((await new Portal(restored, restoredAccess).file(owner.user.id, task.id, 'result.txt')).toString(), 'STORAGE');
  } finally { await restored.close(); await restoredAccess.close(); }
});

test('电脑导入排除新的手机根目录与子目录', async t => {
  const f = await fixture(); const access = new AccessStore(f.root); await access.start(); t.after(() => access.close());
  const owner = await access.setup({ code: access.setupCode, username: 'owner', password: 'storage-test-password' });
  const cwd = await f.storage.createDirectory({ id, name: 'mobile', createdAt: '2026-09-22T01:00:00Z' });
  const client = { request: async () => ({ thread: { id: 'desktop', cwd } }) };
  await assert.rejects(importDesktop(access, client, { username: owner.user.username, threadId: 'desktop' }), /手机项目目录/);
});
