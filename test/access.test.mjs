import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AccessStore } from '../src/access-store.mjs';
import { Portal } from '../src/portal.mjs';
import { createHttpServer } from '../src/server.mjs';
import { importDesktop } from '../src/desktop-import.mjs';
import { Workbench } from '../src/workbench.mjs';

await mkdir('.runtime/tests', { recursive: true });
const password = 'integration-test-password';
async function fixture(t, legacy = false) {
  const root = await mkdtemp(path.resolve('.runtime/tests/auth-'));
  await mkdir(path.join(root, 'workspaces'), { recursive: true });
  const access = new AccessStore(root); await access.start();
  const client = new EventEmitter(); client.calls = []; client.responses = []; let nextThread = 0;
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (client.handler) return client.handler(method, params);
    if (method === 'thread/start') return { thread: { id: 'native-' + (++nextThread) } };
    if (method === 'turn/start') return { turn: { id: 'turn-' + nextThread } };
    return {};
  };
  client.respond = (id, result) => client.responses.push({ id, result }); client.close = () => {};
  const workbench = new Workbench({ root, client }); workbench.connected = true; workbench.signedIn = true;
  workbench.reads = [];
  workbench.readThread = async id => { workbench.reads.push(id); return { id, cwd: 'HOST-PATH', turns: [{ items: [{ type: 'agentMessage', text: 'PRIVATE-CONTENT' }] }] }; };
  if (legacy) {
    const cwd = path.join(root, 'workspaces', 'legacy'); await mkdir(cwd); await writeFile(path.join(cwd, 'old.txt'), 'OLD-ARTIFACT');
    workbench.tasks.set('old-thread', { id: 'old-thread', name: '旧测试', cwd, status: 'completed' });
  }
  const server = createHttpServer(workbench, access, { controlToken: 'local-stop-secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await workbench.close(); await access.close(); });
  const call = async (route, token = '', input) => {
    const response = await fetch(url + '/api' + route, { method: input === undefined ? 'GET' : 'POST',
      headers: { Cookie: 'codex_link_session=' + token, ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'X-Local-Client': '1' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, cookie: response.headers.get('set-cookie') };
  };
  const setup = await call('/auth/setup', '', { code: access.setupCode, username: 'admin', password });
  assert.equal(setup.status, 200);
  const adminToken = setup.cookie.split(';')[0].split('=')[1];
  assert.match(setup.cookie, /HttpOnly; SameSite=Strict/);
  const adminId = setup.data.user.id;
  const alice = await call('/admin/users', adminToken, { username: 'alice', password, level: 2 });
  const bob = await call('/admin/users', adminToken, { username: 'bob', password, level: 1 });
  const login = async username => {
    const result = await call('/auth/login', '', { username, password }); assert.equal(result.status, 200);
    return result.cookie.split(';')[0].split('=')[1];
  };
  return { root, access, workbench, client, server, url, call, login, adminToken, adminId,
    aliceId: alice.data.id, bobId: bob.data.id, aliceToken: await login('alice'), bobToken: await login('bob'), portal: new Portal(workbench, access) };
}

test('未登录不可读取任何项目数据，设置码与密码摘要不通过接口泄漏', async t => {
  const f = await fixture(t, true);
  for (const route of ['/status', '/projects', '/desktop', '/history/old-thread', '/tasks/old-thread/files', '/tasks/old-thread/file?name=old.txt', '/events', '/admin/users']) {
    assert.equal((await f.call(route)).status, 401, route);
  }
  const info = await f.call('/auth'); assert.equal(info.data.setupRequired, false);
  assert.equal(JSON.stringify(info.data).includes('salt'), false);
  assert.equal((await f.call('/auth/setup', '', { code: 'guess', username: 'hacker', password })).status, 403);
  const stored = await readFile(path.join(f.root, 'access.json'), 'utf8');
  assert.equal(stored.includes(password), false);
  assert.equal((await f.call('/server/stop', f.adminToken, {})).status, 403);
  assert.equal((await f.call('/admin/users', f.aliceToken)).status, 403);
});

test('密码只按管理员主动请求返回，列表和普通身份接口不返回明文或密文', async t => {
  const f = await fixture(t);
  const view = `/admin/users/${f.aliceId}/password/view`;
  assert.equal((await f.call(view, '', {})).status, 401);
  assert.equal((await f.call(view, f.aliceToken, {})).status, 403);
  assert.equal((await f.call(view, f.adminToken)).status, 404);
  assert.equal((await f.call(view, f.adminToken, { extra: true })).status, 400);
  assert.equal((await f.call('/admin/users/missing/password/view', f.adminToken, {})).status, 404);
  const result = await f.call(view, f.adminToken, {});
  assert.equal(result.status, 200); assert.deepEqual(result.data, { password });
  for (const route of ['/admin/users', '/auth', '/status']) {
    const response = await f.call(route, f.adminToken);
    const serialized = JSON.stringify(response.data);
    for (const secret of [password, 'passwordDisplay', 'ciphertext', 'salt', 'hash']) assert.equal(serialized.includes(secret), false, route);
  }
  assert.equal((await f.call('/admin/users', f.adminToken)).data.find(u => u.id === f.aliceId).passwordAvailable, true);
  const response = await fetch(f.url + '/api' + view, { method: 'POST', headers: { Cookie: 'codex_link_session=' + f.adminToken, 'Content-Type': 'application/json', 'X-Local-Client': '1' }, body: '{}' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const forged = await fetch(f.url + '/api' + view, { method: 'POST', headers: { Cookie: 'codex_link_session=' + f.adminToken, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(forged.status, 403);
  const disk = await readFile(path.join(f.root, 'access.json'), 'utf8');
  assert.equal(disk.includes(password), false);
  assert.equal((await readFile(path.join(f.root, 'password-view.key'))).length, 32);
  assert.equal((await f.call(`/admin/users/${f.aliceId}`, f.adminToken, { passwordDisplay: {} })).status, 400);
});

test('老账号保留原登录，重设后可查看新密码且撤销该账号的所有旧会话', async t => {
  const f = await fixture(t);
  await f.access.transaction(data => { delete data.users.find(u => u.id === f.aliceId).passwordDisplay; });
  assert.equal((await f.call('/admin/users', f.adminToken)).data.find(u => u.id === f.aliceId).passwordAvailable, false);
  assert.equal((await f.call(`/admin/users/${f.aliceId}/password/view`, f.adminToken, {})).status, 409);
  const secondSession = await f.login('alice');
  const before = JSON.stringify({ projects: f.access.data.projects, bindings: f.access.data.bindings });
  const next = '新的密码628415';
  const route = `/admin/users/${f.aliceId}/password/reset`;
  assert.equal((await f.call(route, '', { password: next })).status, 401);
  assert.equal((await f.call(route, f.aliceToken, { password: next })).status, 403);
  for (const candidate of ['', '12345', 'x'.repeat(129), null, 123456]) assert.equal((await f.call(route, f.adminToken, { password: candidate })).status, 400);
  assert.equal((await f.call(route, f.adminToken, { password: next, role: 'admin' })).status, 400);
  assert.equal((await f.call(`/admin/users/${f.adminId}/password/reset`, f.adminToken, { password: next })).status, 400);
  assert.equal((await f.call('/admin/users/missing/password/reset', f.adminToken, { password: next })).status, 404);
  assert.equal((await f.call(route, f.adminToken, { password: next })).status, 200);
  for (const token of [f.aliceToken, secondSession]) assert.equal((await f.call('/status', token)).status, 401);
  for (const token of [f.bobToken, f.adminToken]) assert.equal((await f.call('/status', token)).status, 200);
  assert.equal((await f.call('/auth/login', '', { username: 'alice', password })).status, 401);
  assert.equal((await f.call('/auth/login', '', { username: 'alice', password: next })).status, 200);
  assert.equal((await f.call(`/admin/users/${f.aliceId}/password/view`, f.adminToken, {})).data.password, next);
  assert.equal(JSON.stringify({ projects: f.access.data.projects, bindings: f.access.data.bindings }), before);
  assert.equal((await readFile(path.join(f.root, 'access.json'), 'utf8')).includes(next), false);
  await f.access.close(); await f.access.start();
  assert.equal((await f.access.login({ username: 'alice', password: next })).user.id, f.aliceId);
  assert.equal(f.access.viewPassword(f.adminId, f.aliceId, {}).password, next);
});

test('本人改密同步可查看密码，旧密文不能错配账号或密码摘要，停用账号重设不会启用', async t => {
  const f = await fixture(t);
  const original = structuredClone(f.access.data.users.find(u => u.id === f.aliceId).passwordDisplay);
  const next = 'x'.repeat(128);
  assert.equal((await f.call('/auth/password', f.aliceToken, { currentPassword: password, password: next })).status, 200);
  assert.equal(f.access.viewPassword(f.adminId, f.aliceId, {}).password, next);
  await f.access.transaction(data => { data.users.find(u => u.id === f.aliceId).passwordDisplay = original; });
  assert.equal((await f.call(`/admin/users/${f.aliceId}/password/view`, f.adminToken, {})).status, 409);
  await f.access.transaction(data => { data.users.find(u => u.id === f.aliceId).passwordDisplay = structuredClone(data.users.find(u => u.id === f.bobId).passwordDisplay); });
  assert.equal((await f.call(`/admin/users/${f.aliceId}/password/view`, f.adminToken, {})).status, 409);
  await f.access.updateUser(f.adminId, f.aliceId, { disabled: true });
  await f.access.resetPassword(f.adminId, f.aliceId, { password: '628415' });
  assert.equal(f.access.data.users.find(u => u.id === f.aliceId).disabled, true);
  assert.equal((await f.call('/auth/login', '', { username: 'alice', password: '628415' })).status, 401);
  assert.equal(f.access.viewPassword(f.adminId, f.aliceId, {}).password, '628415');
});

test('显示密钥丢失或损坏时不替换密钥，原登录仍可用；恢复密钥后可重新查看', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'password-view.key'), key = await readFile(file);
  await f.access.close(); await unlink(file); await f.access.start();
  assert.equal((await f.access.login({ username: 'alice', password })).user.id, f.aliceId);
  assert.throws(() => f.access.viewPassword(f.adminId, f.aliceId, {}), e => e.statusCode === 503);
  await assert.rejects(f.access.resetPassword(f.adminId, f.aliceId, { password: '628415' }), e => e.statusCode === 503);
  await assert.rejects(readFile(file), e => e.code === 'ENOENT');
  await f.access.close(); await writeFile(file, 'broken-key'); await f.access.start();
  assert.throws(() => f.access.viewPassword(f.adminId, f.aliceId, {}), e => e.statusCode === 503);
  await f.access.close(); await writeFile(file, key); await f.access.start();
  assert.equal(f.access.viewPassword(f.adminId, f.aliceId, {}).password, password);
});

test('写入失败和中途注销不能提交新密码，也不撤销目标账号的原会话', async t => {
  const f = await fixture(t), before = JSON.stringify(f.access.data);
  await mkdir(path.join(f.root, 'access.json.tmp'));
  assert.equal((await f.call(`/admin/users/${f.aliceId}/password/reset`, f.adminToken, { password: '628415' })).status, 400);
  assert.equal(JSON.stringify(f.access.data), before);
  assert.equal((await f.call('/status', f.aliceToken)).status, 200);
  await rmdir(path.join(f.root, 'access.json.tmp'));
  let checked = 0;
  await assert.rejects(f.access.resetPassword(f.adminId, f.aliceId, { password: '628415' }, () => {
    f.access.session(f.adminToken);
    if (++checked === 1) queueMicrotask(() => f.access.logout(f.adminToken));
  }), e => e.statusCode === 401);
  assert.equal(JSON.stringify(f.access.data), before);
  assert.equal((await f.call('/status', f.aliceToken)).status, 200);
  assert.equal(f.access.viewPassword(f.adminId, f.aliceId, {}).password, password);
});

test('升级纯旧版账号库只生成独立密钥，不改账号文件或自动收集旧登录密码', async t => {
  const f = await fixture(t), legacy = structuredClone(f.access.data);
  for (const user of legacy.users) delete user.passwordDisplay;
  const root = await mkdtemp(path.resolve('.runtime/tests/legacy-password-'));
  const content = JSON.stringify(legacy, null, 2);
  await writeFile(path.join(root, 'access.json'), content);
  const restored = new AccessStore(root); t.after(() => restored.close()); await restored.start();
  assert.equal((await readFile(path.join(root, 'password-view.key'))).length, 32);
  assert.equal((await restored.login({ username: 'alice', password })).user.id, f.aliceId);
  assert.equal(await readFile(path.join(root, 'access.json'), 'utf8'), content);
  assert.equal(restored.users(f.adminId).every(user => !user.passwordAvailable), true);
  assert.throws(() => restored.viewPassword(f.adminId, f.aliceId, {}), e => e.statusCode === 409);
});

test('首次归属迁移保留旧成果；未绑定电脑历史猜测与私有项目均被拒绝', async t => {
  const f = await fixture(t, true);
  const owner = await f.call('/status', f.adminToken);
  assert.equal(owner.data.projects.length, 1); assert.equal(owner.data.projects[0].shared, false);
  assert.equal((await f.call('/tasks/old-thread/file?name=old.txt', f.adminToken)).data, 'OLD-ARTIFACT');
  assert.equal((await f.call('/status', f.aliceToken)).data.tasks.length, 0);
  assert.equal((await f.call('/history/old-thread', f.aliceToken)).status, 404);
  assert.equal((await f.call('/history/arbitrary-native-thread', f.adminToken)).status, 404);
  assert.deepEqual(f.workbench.reads, []);
});

test('私有优先于管理员等级；来源归属不可伪造；普通用户只能预设项目等级', async t => {
  const f = await fixture(t);
  const project = (await f.call('/projects', f.aliceToken, { name: 'Alice 的私密资料', level: 5 })).data;
  assert.equal(project.source, 'mobile'); assert.equal(project.ownerId, f.aliceId); assert.equal(project.shared, false);
  const task = (await f.call('/tasks', f.aliceToken, { projectId: project.id, name: '私密任务' })).data;
  for (const token of [f.adminToken, f.bobToken]) {
    assert.equal((await f.call('/status', token)).data.tasks.length, 0);
    for (const route of [`/history/${task.id}`, `/tasks/${task.id}/files`, `/tasks/${task.id}/file?name=secret.txt`]) assert.equal((await f.call(route, token)).status, 404);
  }
  assert.equal((await f.call('/projects', f.aliceToken, { name: '伪造', source: 'desktop', ownerId: f.bobId })).status, 400);
  assert.equal((await f.call(`/projects/${project.id}`, f.aliceToken, { level: 0 })).status, 403);
  assert.equal((await f.call(`/projects/${project.id}`, f.aliceToken, { ownerId: f.bobId })).status, 400);
  const adminUpdate = await f.call(`/projects/${project.id}`, f.adminToken, { level: 7 });
  assert.deepEqual(adminUpdate.data, { id: project.id, level: 7 });
  assert.equal((await f.call(`/projects/${project.id}`, f.adminToken, { shared: true })).status, 403);
  assert.equal((await f.call('/projects?q=Alice', f.adminToken)).data.length, 0);
});

test('共享匹配等级并保护历史、文件、下载；降级、撤销共享立即收回权限', async t => {
  const f = await fixture(t);
  const project = (await f.call('/projects', f.aliceToken, { name: '共享资料', level: 2 })).data;
  const task = (await f.call('/tasks', f.aliceToken, { projectId: project.id, name: '任务' })).data;
  const stored = f.access.data.projects.find(p => p.id === project.id);
  await writeFile(path.join(stored.cwd, 'result.txt'), 'ALICE-RESULT');
  await f.call(`/projects/${project.id}`, f.aliceToken, { shared: true });
  assert.equal((await f.call(`/tasks/${task.id}/files`, f.bobToken)).status, 404);
  assert.equal((await f.call('/projects', f.adminToken)).data.length, 1);
  await f.call(`/admin/users/${f.bobId}`, f.adminToken, { level: 2 });
  assert.equal((await f.call('/status', f.bobToken)).status, 401);
  const bob = await f.login('bob');
  assert.equal((await f.call(`/history/${task.id}`, bob)).status, 200);
  assert.equal((await f.call(`/tasks/${task.id}/file?name=result.txt`, bob)).data, 'ALICE-RESULT');
  assert.equal((await f.call('/tasks', bob, { projectId: project.id, name: '擅自创建' })).status, 403);
  assert.equal((await f.call(`/tasks/${task.id}/send`, bob, { prompt: '写入' })).status, 403);
  await f.call(`/admin/users/${f.bobId}`, f.adminToken, { level: 1 });
  const downgraded = await f.login('bob');
  assert.equal((await f.call(`/tasks/${task.id}/file?name=result.txt`, downgraded)).status, 404);
  await f.call(`/projects/${project.id}`, f.aliceToken, { shared: false });
  assert.equal((await f.call(`/history/${task.id}`, f.adminToken)).status, 404);
});

test('所有者可创建和发送原生任务；其他账号无法操作，路径和执行参数不能注入', async t => {
  const f = await fixture(t);
  const project = (await f.call('/projects', f.aliceToken, { name: '待办', level: 0 })).data;
  const task = (await f.call('/tasks', f.aliceToken, { projectId: project.id, name: '待接入' })).data;
  assert.equal(task.connectedToCodex, true); assert.equal(task.status, 'idle'); assert.equal(task.canExecute, true);
  const stored = f.access.data.projects.find(p => p.id === project.id);
  assert.equal(f.workbench.tasks.get(task.id).cwd, stored.cwd);
  for (const action of ['send', 'answer', 'stop']) {
    assert.equal((await f.call(`/tasks/${task.id}/${action}`, f.bobToken, { prompt: '执行' })).status, 404);
    assert.equal((await f.call(`/tasks/${task.id}/${action}`, f.adminToken, { prompt: '执行' })).status, 404);
  }
  assert.equal((await f.call(`/tasks/${task.id}/send`, f.aliceToken, { prompt: '执行', cwd: 'C:/' })).status, 400);
  const sent = await f.call(`/tasks/${task.id}/send`, f.aliceToken, { prompt: '执行' });
  assert.equal(sent.status, 200); assert.equal(sent.data.task.id, task.id); assert.equal('cwd' in sent.data.task, false);
  assert.equal((await f.call(`/tasks/${task.id}/send`, f.aliceToken, { prompt: '重复' })).status, 409);
  assert.equal(f.client.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal((await f.call(`/tasks/${task.id}/file?name=..%2F..%2Faccess.json`, f.aliceToken)).status, 400);
  assert.deepEqual(f.workbench.reads, []);
  assert.equal(f.workbench.tasks.size, 1);
});

test('旧草稿并发发送只绑定一次；原生事件、停止、追问均映射到原账号任务', async t => {
  const f = await fixture(t);
  const project = (await f.call('/projects', f.aliceToken, { name: '旧草稿', level: 0 })).data;
  await f.access.transaction(data => data.bindings.push({ id: 'draft_old', threadId: null, projectId: project.id, name: '保留编号', createdAt: new Date().toISOString() }));
  const results = await Promise.all([f.call('/tasks/draft_old/send', f.aliceToken, { prompt: 'first' }), f.call('/tasks/draft_old/send', f.aliceToken, { prompt: 'second' })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.client.calls.filter(c => c.method === 'thread/start').length, 1);
  const { threadId } = f.access.data.bindings[0];
  assert.ok(threadId); assert.equal(f.access.data.bindings[0].id, 'draft_old');
  f.client.emit('message', { method: 'turn/started', params: { threadId, turn: { id: 'turn-live' } } });
  f.client.emit('message', { id: 81, method: 'item/tool/requestUserInput', params: { threadId, questions: [{ id: 'format', question: '格式？' }] } });
  const status = (await f.call('/status', f.aliceToken)).data;
  assert.equal(status.questions[0].taskId, 'draft_old');
  await f.call(`/projects/${project.id}`, f.aliceToken, { shared: true });
  const sharedStatus = (await f.call('/status', f.bobToken)).data;
  assert.deepEqual(sharedStatus.questions, []); assert.equal(sharedStatus.tasks[0].canExecute, false);
  for (const action of ['answer', 'stop']) assert.equal((await f.call(`/tasks/draft_old/${action}`, f.bobToken, {})).status, 403);
  assert.equal((await f.call('/tasks/draft_old/answer', f.aliceToken, { requestId: 81, answers: { format: 'txt' } })).status, 200);
  assert.deepEqual(f.client.responses[0].result, { answers: { format: { answers: ['txt'] } } });
  assert.equal((await f.call('/tasks/draft_old/stop', f.aliceToken, {})).status, 200);
  assert.equal(f.client.calls.at(-1).params.threadId, threadId);
  assert.equal(f.portal.event(f.aliceId, { type: 'codex', data: { taskId: threadId } }).data.taskId, 'draft_old');
});

test('发送在恢复任务期间注销，实际执行前再次检查会话', async t => {
  const f = await fixture(t);
  const project = (await f.call('/projects', f.aliceToken, { name: '撤权', level: 0 })).data;
  const task = (await f.call('/tasks', f.aliceToken, { projectId: project.id, name: '任务' })).data;
  f.workbench.loaded.clear();
  let release, ready;
  const started = new Promise(resolve => ready = resolve);
  f.client.handler = method => { if (method === 'thread/resume') { ready(); return new Promise(resolve => release = resolve); } return {}; };
  const pending = f.call(`/tasks/${task.id}/send`, f.aliceToken, { prompt: 'execute' });
  await started; await f.call('/auth/logout', f.aliceToken, {}); release({});
  assert.equal((await pending).status, 401);
  assert.equal(f.client.calls.some(c => c.method === 'turn/start'), false);
});

test('异步历史读取期间撤销共享，响应不会带出旧权限内容', async t => {
  const f = await fixture(t, true);
  const project = f.access.data.projects[0];
  await f.portal.updateProject(f.adminId, project.id, { shared: true });
  let resolveRead, startRead;
  const started = new Promise(resolve => startRead = resolve);
  f.workbench.readThread = () => { startRead(); return new Promise(resolve => resolveRead = resolve); };
  const pending = f.call('/history/old-thread', f.aliceToken);
  await started; await f.portal.updateProject(f.adminId, project.id, { shared: false });
  resolveRead({ turns: [{ items: [{ text: 'MUST-NOT-LEAK' }] }] });
  const result = await pending; assert.equal(result.status, 404); assert.equal(JSON.stringify(result.data).includes('MUST-NOT-LEAK'), false);
});

test('SSE 隐藏私有任务和原始工具载荷，撤权通知关闭旧流', async t => {
  const f = await fixture(t, true);
  const stream = await fetch(f.url + '/api/events', { headers: { Cookie: 'codex_link_session=' + f.aliceToken } });
  const reader = stream.body.getReader(); await reader.read();
  f.workbench.emit('event', { type: 'codex', data: { taskId: 'old-thread', params: { secret: 'MUST-NOT-LEAK' } } });
  await f.portal.updateProject(f.adminId, f.access.data.projects[0].id, { shared: true });
  let text = '';
  while (true) { const chunk = await reader.read(); if (chunk.done) break; text += Buffer.from(chunk.value).toString(); }
  assert.match(text, /access-changed/); assert.equal(text.includes('old-thread'), false); assert.equal(text.includes('MUST-NOT-LEAK'), false);
  const event = f.portal.event(f.aliceId, { type: 'codex', data: { taskId: 'old-thread', params: { secret: 'MUST-NOT-LEAK' } } });
  assert.equal(event.type, 'task-changed'); assert.equal(JSON.stringify(event).includes('MUST-NOT-LEAK'), false);
});

test('注销、停用和改密使旧会话失效，密码校验及限速生效', async t => {
  const f = await fixture(t);
  await f.call('/auth/logout', f.aliceToken, {});
  assert.equal((await f.call('/status', f.aliceToken)).status, 401);
  const token = await f.login('alice');
  assert.equal((await f.call('/auth/password', token, { currentPassword: password, password: 'new-password-for-tests' })).status, 200);
  assert.equal((await f.call('/status', token)).status, 401);
  assert.equal((await f.call('/auth/login', '', { username: 'alice', password })).status, 401);
  const login = await f.call('/auth/login', '', { username: 'alice', password: 'new-password-for-tests' }); assert.equal(login.status, 200);
  await f.call(`/admin/users/${f.bobId}`, f.adminToken, { disabled: true });
  assert.equal((await f.call('/status', f.bobToken)).status, 401);
  for (let i = 0; i < 8; i++) await f.call('/auth/login', '', { username: 'nobody', password });
  assert.equal((await f.call('/auth/login', '', { username: 'nobody', password })).status, 429);
});

test('并发初始化只有一个成功；落盘失败不发布半份账号', async t => {
  const root = await mkdtemp(path.resolve('.runtime/tests/store-'));
  const access = new AccessStore(root); await access.start(); t.after(() => access.close());
  const input = { code: access.setupCode, username: 'admin', password };
  const results = await Promise.allSettled([access.setup(input), access.setup(input)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(access.data.users.length, 1);
  const failedRoot = await mkdtemp(path.resolve('.runtime/tests/fail-'));
  const failed = new AccessStore(failedRoot); await failed.start(); t.after(() => failed.close());
  await mkdir(path.join(failedRoot, 'access.json'));
  await assert.rejects(failed.setup({ code: failed.setupCode, username: 'admin', password }));
  assert.equal(failed.data.users.length, 0); assert.equal(failed.sessions.size, 0);
  await rmdir(path.join(failedRoot, 'access.json'));
  await failed.setup({ code: failed.setupCode, username: 'admin', password }); assert.equal(failed.data.users.length, 1);
});

test('重启保留账号与项目，旧会话失效；桌面导入保留来源与原目录', async t => {
  const f = await fixture(t);
  const desktop = await mkdtemp(path.resolve('.runtime/tests/desktop-'));
  await writeFile(path.join(desktop, 'report.txt'), 'DESKTOP-FILE');
  const client = { request: async () => ({ thread: { id: 'native-thread', name: '电脑任务', cwd: desktop } }) };
  const result = await importDesktop(f.access, client, { username: 'alice', threadId: 'native-thread', projectLevel: 3 });
  assert.equal(result.source, 'desktop');
  assert.equal((await f.call('/desktop', f.aliceToken)).data.data.length, 1);
  assert.equal((await f.call('/desktop', f.adminToken)).data.data.length, 0);
  assert.equal((await f.call('/tasks/native-thread/file?name=report.txt', f.aliceToken)).data, 'DESKTOP-FILE');
  assert.equal((await f.call('/tasks', f.aliceToken, { projectId: result.projectId, name: '不能变来源' })).status, 403);
  await assert.rejects(importDesktop(f.access, client, { username: 'bob', threadId: 'native-thread' }), /已登记/);
  const nested = path.join(desktop, 'nested'); await mkdir(nested);
  const overlapping = { request: async () => ({ thread: { id: 'nested-thread', cwd: nested } }) };
  await assert.rejects(importDesktop(f.access, overlapping, { username: 'bob', threadId: 'nested-thread' }), /重叠/);
  await f.access.close();
  const restored = new AccessStore(f.root); await restored.start(); t.after(() => restored.close());
  assert.throws(() => restored.session(f.aliceToken), /登录/);
  assert.equal(restored.data.projects.find(p => p.id === result.projectId).cwd, await (await import('node:fs/promises')).realpath(desktop));
  assert.equal((await restored.login({ username: 'alice', password })).user.id, f.aliceId);
});

test('只有所有者可移除项目及绑定，文件和原生记录保留，旧入口与重启均不可见', async t => {
  const f = await fixture(t);
  const p = (await f.call('/projects', f.aliceToken, { name: '删除验收', level: 0 })).data;
  const task = (await f.call('/tasks', f.aliceToken, { projectId: p.id, name: '保留成果' })).data;
  const sibling = (await f.call('/projects', f.aliceToken, { name: '不受影响', level: 0 })).data;
  const stored = f.access.data.projects.find(x => x.id === p.id);
  const artifact = path.join(stored.cwd, 'keep.txt'); await writeFile(artifact, 'KEEP-EXACT-BYTES');
  const registry = await readFile(path.join(f.root, 'registry.json'), 'utf8');
  const route = `/projects/${p.id}/remove`, input = { confirmName: p.name };
  assert.equal((await f.call(route, '', input)).status, 401);
  assert.equal((await f.call(route, f.adminToken, input)).status, 404);
  await f.call(`/projects/${p.id}`, f.aliceToken, { shared: true });
  for (const token of [f.adminToken, f.bobToken]) assert.equal((await f.call(route, token, input)).status, 403);
  for (const invalid of [{}, { confirmName: '旧名称' }, { ...input, cwd: stored.cwd }, { ...input, deleteFiles: true }]) {
    assert.equal((await f.call(route, f.aliceToken, invalid)).status, 409);
  }
  const response = await f.call(route, f.aliceToken, input);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { removed: true, projectId: p.id, removedTasks: 1, filesKept: true, codexHistoryKept: true });
  assert.equal((await f.call(route, f.aliceToken, input)).status, 404);
  for (const token of [f.aliceToken, f.bobToken, f.adminToken]) {
    const status = (await f.call('/status', token)).data;
    assert.equal(status.projects.some(x => x.id === p.id), false); assert.equal(status.tasks.some(x => x.id === task.id), false);
    for (const endpoint of [`/history/${task.id}`, `/tasks/${task.id}/files`, `/tasks/${task.id}/file?name=keep.txt`]) assert.equal((await f.call(endpoint, token)).status, 404);
  }
  assert.equal((await f.call(`/tasks/${task.id}/send`, f.aliceToken, { prompt: '已删除' })).status, 404);
  assert.equal((await f.call('/tasks', f.aliceToken, { projectId: p.id, name: '已删除' })).status, 404);
  assert.equal(f.portal.event(f.aliceId, { type: 'codex', data: { taskId: task.id } }), null);
  assert.equal(await readFile(artifact, 'utf8'), 'KEEP-EXACT-BYTES');
  assert.equal(await readFile(path.join(f.root, 'registry.json'), 'utf8'), registry);
  assert.equal(f.workbench.tasks.has(task.id), true);
  assert.equal(f.access.data.projects.some(x => x.id === sibling.id), true);
  await f.access.close(); const restored = new AccessStore(f.root); await restored.start(); t.after(() => restored.close());
  assert.equal(restored.data.projects.some(x => x.id === p.id), false); assert.equal(restored.data.bindings.some(x => x.id === task.id), false);
});

test('忙碌、等待与结果不明的项目不可移除；空项目及电脑登记仅移除工作台记录', async t => {
  const f = await fixture(t);
  const p = (await f.call('/projects', f.aliceToken, { name: '状态验收' })).data;
  const task = (await f.call('/tasks', f.aliceToken, { projectId: p.id, name: '任务' })).data;
  const live = f.workbench.tasks.get(task.id), route = `/projects/${p.id}/remove`, input = { confirmName: p.name };
  for (const patch of [{ busy: true }, { activeTurn: 'live' }, ...['starting', 'running', 'waiting', 'waiting-input', 'unknown'].map(status => ({ status }))]) {
    Object.assign(live, { busy: false, activeTurn: null, status: 'idle' }, patch);
    assert.equal((await f.call(route, f.aliceToken, input)).status, 409);
  }
  Object.assign(live, { busy: false, activeTurn: null, status: 'completed' });
  f.workbench.questions.set('pending', { taskId: task.id });
  assert.equal((await f.call(route, f.aliceToken, input)).status, 409); f.workbench.questions.clear();
  assert.equal((await f.call(route, f.aliceToken, input)).status, 200);
  const empty = (await f.call('/projects', f.aliceToken, { name: '空项目' })).data;
  assert.equal((await f.call(`/projects/${empty.id}/remove`, f.aliceToken, { confirmName: empty.name })).data.removedTasks, 0);
  const desktop = await mkdtemp(path.resolve('.runtime/tests/remove-desktop-')); await writeFile(path.join(desktop, 'keep.txt'), 'DESKTOP-KEEP');
  const imported = await importDesktop(f.access, { request: async () => ({ thread: { id: 'desktop-keep', cwd: desktop } }) }, { username: 'alice', threadId: 'desktop-keep' });
  const project = f.access.data.projects.find(p => p.id === imported.projectId);
  assert.equal((await f.call(`/projects/${project.id}/remove`, f.aliceToken, { confirmName: project.name })).status, 200);
  assert.equal(await readFile(path.join(desktop, 'keep.txt'), 'utf8'), 'DESKTOP-KEEP');
});

test('移除落盘窗口阻止发送与排队创建，并在完成后拒绝正在读取的旧历史', async t => {
  const f = await fixture(t);
  const p = (await f.call('/projects', f.aliceToken, { name: '并发验收' })).data;
  const task = (await f.call('/tasks', f.aliceToken, { projectId: p.id, name: '任务' })).data;
  let finishRead, startedRead; const reading = new Promise(resolve => startedRead = resolve);
  f.workbench.readThread = () => { startedRead(); return new Promise(resolve => finishRead = resolve); };
  const history = f.call(`/history/${task.id}`, f.aliceToken); await reading;
  const transact = f.access.transaction.bind(f.access); let releaseCommit, enteredCommit;
  const entered = new Promise(resolve => enteredCommit = resolve), held = new Promise(resolve => releaseCommit = resolve);
  f.access.transaction = (change, permissions) => transact(async data => { const result = await change(data); if (f.access.removingProjects.has(p.id)) { enteredCommit(); await held; } return result; }, permissions);
  const removing = f.call(`/projects/${p.id}/remove`, f.aliceToken, { confirmName: p.name }); await entered;
  assert.equal((await f.call(`/tasks/${task.id}/send`, f.aliceToken, { prompt: '不能开始' })).status, 409);
  const creating = f.call('/tasks', f.aliceToken, { projectId: p.id, name: '不能创建' });
  releaseCommit(); assert.equal((await removing).status, 200); assert.equal((await creating).status, 404);
  finishRead({ turns: [{ items: [{ text: 'MUST-NOT-LEAK' }] }] });
  const result = await history; assert.equal(result.status, 404); assert.equal(JSON.stringify(result.data).includes('MUST-NOT-LEAK'), false);
  assert.equal(f.client.calls.some(c => c.method === 'turn/start'), false); assert.equal(f.access.removingProjects.size, 0);
});

test('移除落盘失败不改变项目和绑定，释放预留后原任务仍可执行', async t => {
  const f = await fixture(t);
  const p = (await f.call('/projects', f.aliceToken, { name: '失败验收' })).data;
  const task = (await f.call('/tasks', f.aliceToken, { projectId: p.id, name: '任务' })).data;
  const previous = JSON.stringify(f.access.data), disk = await readFile(path.join(f.root, 'access.json'), 'utf8');
  // This empty fixture directory makes the transaction's file write fail.
  const obstruction = path.join(f.root, 'access.json.tmp'); await mkdir(obstruction);
  try { await assert.rejects(f.portal.removeProject(f.aliceId, p.id, { confirmName: p.name })); }
  finally { await rmdir(obstruction); }
  assert.equal(JSON.stringify(f.access.data), previous); assert.equal(await readFile(path.join(f.root, 'access.json'), 'utf8'), disk);
  assert.equal(f.access.removingProjects.size, 0);
  assert.equal((await f.call(`/tasks/${task.id}/send`, f.aliceToken, { prompt: '继续原任务' })).status, 200);
});

test('创建先完成再移除会包含新任务；排队删除时注销必须拒绝', async t => {
  const f = await fixture(t);
  const p = (await f.call('/projects', f.aliceToken, { name: '队列验收' })).data;
  let release, entered; const ready = new Promise(resolve => entered = resolve);
  f.client.handler = method => method === 'thread/start' ? (entered(), new Promise(resolve => release = resolve)) : {};
  const creating = f.call('/tasks', f.aliceToken, { projectId: p.id, name: '正在创建' }); await ready;
  const removing = f.call(`/projects/${p.id}/remove`, f.aliceToken, { confirmName: p.name });
  release({ thread: { id: 'queued-create' } }); assert.equal((await creating).status, 201); assert.equal((await removing).data.removedTasks, 1);
  const other = (await f.call('/projects', f.aliceToken, { name: '注销验收' })).data;
  let unlock, heldReady; const started = new Promise(resolve => heldReady = resolve);
  const blocking = f.access.transaction(async () => { heldReady(); await new Promise(resolve => unlock = resolve); }); await started;
  const queued = f.portal.removeProject(f.aliceId, other.id, { confirmName: other.name }, () => f.access.session(f.aliceToken));
  await f.call('/auth/logout', f.aliceToken, {}); unlock(); await blocking;
  await assert.rejects(queued, error => error.statusCode === 401); assert.equal(f.access.data.projects.some(p => p.id === other.id), true);
});

test('旧草稿排队绑定前项目已移除，不产生新原生任务', async t => {
  const f = await fixture(t);
  const p = (await f.call('/projects', f.aliceToken, { name: '草稿删除' })).data;
  await f.access.transaction(data => data.bindings.push({ id: 'remove-draft', threadId: null, projectId: p.id, name: '草稿', createdAt: new Date().toISOString() }));
  let unlock, heldReady; const started = new Promise(resolve => heldReady = resolve);
  const blocking = f.access.transaction(async () => { heldReady(); await new Promise(resolve => unlock = resolve); }); await started;
  const removing = f.portal.removeProject(f.aliceId, p.id, { confirmName: p.name });
  const sending = assert.rejects(f.portal.send(f.aliceId, 'remove-draft', { prompt: '不能绑定' }), error => error.statusCode === 404);
  unlock(); await blocking; await removing; await sending;
  assert.equal(f.client.calls.some(c => c.method === 'thread/start'), false);
});

test('首个管理员密码接受 6 位，拒绝 5 位与 129 位且不写入半份账号', async t => {
  const root = await mkdtemp(path.resolve('.runtime/tests/password-'));
  const access = new AccessStore(root); await access.start(); t.after(() => access.close());
  for (const candidate of ['12345', 'x'.repeat(129)]) {
    await assert.rejects(access.setup({ code: access.setupCode, username: 'admin', password: candidate }), error => error.statusCode === 400 && /6–128/.test(error.message));
    assert.equal(access.data.users.length, 0);
  }
  const created = await access.setup({ code: access.setupCode, username: 'admin', password: '628415' });
  assert.equal((await access.login({ username: 'admin', password: '628415' })).user.id, created.user.id);
});

test('HTTP 账号创建和改密支持 6 位，保留长度上限及已有长密码登录', async t => {
  const f = await fixture(t);
  for (const candidate of ['12345', 'x'.repeat(129)]) {
    const rejected = await f.call('/admin/users', f.adminToken, { username: 'invalid_length', password: candidate });
    assert.equal(rejected.status, 400); assert.match(rejected.data.error, /6–128/);
  }
  assert.equal(f.access.data.users.some(u => u.username === 'invalid_length'), false);
  for (const [account, candidate] of [['six_chars', '628415'], ['max_chars', 'x'.repeat(128)]]) {
    assert.equal((await f.call('/admin/users', f.adminToken, { username: account, password: candidate })).status, 201);
    assert.equal((await f.call('/auth/login', '', { username: account, password: candidate })).status, 200);
  }
  const login = await f.call('/auth/login', '', { username: 'six_chars', password: '628415' });
  const token = login.cookie.split(';')[0].split('=')[1];
  for (const candidate of ['12345', 'x'.repeat(129)]) {
    assert.equal((await f.call('/auth/password', token, { currentPassword: '628415', password: candidate })).status, 400);
    assert.equal((await f.call('/status', token)).status, 200);
  }
  assert.equal((await f.call('/auth/password', token, { currentPassword: '628415', password: '714826' })).status, 200);
  assert.equal((await f.call('/status', token)).status, 401);
  assert.equal((await f.call('/auth/login', '', { username: 'six_chars', password: '628415' })).status, 401);
  assert.equal((await f.call('/auth/login', '', { username: 'six_chars', password: '714826' })).status, 200);
  assert.equal((await f.call('/auth/login', '', { username: 'alice', password })).status, 200);
});
