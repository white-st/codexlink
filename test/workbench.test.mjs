import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { Workbench } from '../src/workbench.mjs';
import { isWithin, listFiles, readArtifact } from '../src/files.mjs';
import { createHttpServer } from '../src/server.mjs';
import { acquireLock } from '../src/runtime-lock.mjs';
import { AccessStore } from '../src/access-store.mjs';

await mkdir('.runtime/tests', { recursive: true });
async function fixture() { return mkdtemp(path.resolve('.runtime/tests/case-')); }
class FakeClient extends EventEmitter {
  constructor() { super(); this.calls = []; this.responses = []; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (this.handler) return this.handler(method, params);
    if (method === 'thread/resume') return {};
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  rejectRequest(id, message) { this.responses.push({ id, error: message }); }
  close() {}
}
async function setup() {
  const root = await fixture(); const client = new FakeClient(); const workbench = new Workbench({ root, client });
  workbench.connected = true;
  const task = { id: 'owned-task', cwd: path.join(root, 'workspaces', 'test'), status: 'idle', busy: false };
  await mkdir(task.cwd, { recursive: true }); workbench.tasks.set(task.id, task);
  return { workbench, task, client };
}

test('成果访问阻止目录穿越、绝对路径、Windows 备用数据流', async () => {
  const root = await fixture(); await writeFile(path.join(root, 'ok.txt'), 'ok');
  assert.equal((await readArtifact(root, 'ok.txt')).toString(), 'ok');
  for (const name of ['../outside.txt', path.resolve(root, '../outside.txt'), 'ok.txt:secret']) {
    await assert.rejects(readArtifact(root, name));
  }
  assert.equal(isWithin(root, root + '-other'), false);
});

test('成果访问阻止目录链接跳出工作区', async () => {
  const root = await fixture(); const outside = await fixture(); await writeFile(path.join(outside, 'secret.txt'), 'private');
  await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readArtifact(root, 'link/secret.txt'), /之外/);
  assert.deepEqual(await listFiles(root), []);
});

test('不能向已有电脑任务发指令或停止任务', async () => {
  const { workbench, client } = await setup();
  await assert.rejects(workbench.send('desktop-task', 'modify files'), /只能操作/);
  await assert.rejects(workbench.stop('desktop-task'), /只能操作/);
  assert.equal(client.calls.length, 0);
});

test('并发提交只允许一个轮次，重连会先恢复自己的任务', async () => {
  const { workbench, task, client } = await setup();
  const first = workbench.send(task.id, 'create a file');
  await assert.rejects(workbench.send(task.id, 'duplicate'), /正在执行/);
  await first;
  assert.deepEqual(client.calls.map(call => call.method), ['thread/resume', 'turn/start']);
  const params = client.calls[1].params;
  assert.equal(params.approvalPolicy, 'never');
  assert.deepEqual(params.sandboxPolicy.writableRoots, [task.cwd]);
});

test('请求超时保留结果未知状态，不自动重复发送', async () => {
  const { workbench, task, client } = await setup();
  workbench.loaded.add(task.id);
  client.handler = () => { throw Object.assign(new Error('timeout'), { code: 'RPC_TIMEOUT' }); };
  await assert.rejects(workbench.send(task.id, 'create a file'), /timeout/);
  assert.equal(task.status, 'unknown'); assert.equal(task.busy, true);
  await assert.rejects(workbench.send(task.id, 'retry'), /正在执行/);
  assert.equal(client.calls.length, 1);
});

test('旧的已完成轮次不会解锁正在提交的新轮次', async () => {
  const { workbench, task, client } = await setup();
  task.status = 'starting'; task.busy = true;
  client.handler = () => ({ thread: { status: { type: 'idle' }, turns: [{ id: 'old', status: 'completed' }] } });
  await workbench.reconcile(task.id);
  assert.equal(task.busy, true);
  task.status = 'running'; task.activeTurn = 'new';
  await workbench.reconcile(task.id); assert.equal(task.busy, true);
});

test('提交响应到达但执行未开始时，不暴露可停止的轮次', async () => {
  const { workbench, task, client } = await setup();
  await workbench.send(task.id, 'hello');
  assert.equal(task.activeTurn, undefined);
  await assert.rejects(workbench.stop(task.id), /尚未进入/);
  assert.equal(client.calls.some(call => call.method === 'turn/interrupt'), false);
});

test('停止请求不伪造完成，收到终止事件才解锁', async () => {
  const { workbench, task, client } = await setup();
  task.busy = true; task.status = 'running'; task.activeTurn = 'turn-1'; workbench.loaded.add(task.id);
  await workbench.stop(task.id); assert.equal(task.status, 'running');
  client.emit('message', { method: 'turn/completed', params: { threadId: task.id, turn: { id: 'turn-1', status: 'interrupted' } } });
  assert.equal(task.busy, false); assert.equal(task.status, 'interrupted');
  await workbench.writeQueue;
});

test('快速完成事件先于请求响应时不会重新锁定任务', async () => {
  const { workbench, task, client } = await setup(); workbench.loaded.add(task.id);
  client.handler = () => {
    client.emit('message', { method: 'turn/completed', params: { threadId: task.id, turn: { id: 'fast', status: 'completed' } } });
    return { turn: { id: 'fast' } };
  };
  await workbench.send(task.id, 'hello'); assert.equal(task.busy, false); assert.equal(task.activeTurn, null);
});

test('权限申请不自动扩大范围，未知工具请求被拒绝', async () => {
  const { workbench, task, client } = await setup();
  client.emit('message', { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: task.id } });
  client.emit('message', { id: 2, method: 'item/permissions/requestApproval', params: { threadId: task.id } });
  client.emit('message', { id: 3, method: 'unsupported/action', params: { threadId: task.id } });
  assert.equal(client.responses[0].result.decision, 'decline');
  assert.deepEqual(client.responses[1].result.permissions, {});
  assert.ok(client.responses[2].error);
});

test('追问回答只能交给对应任务，过期问题拒绝提交', async () => {
  const { workbench, task, client } = await setup();
  client.emit('message', { id: 7, method: 'item/tool/requestUserInput', params: {
    threadId: task.id, questions: [{ id: 'format', question: '格式？' }],
  } });
  workbench.tasks.set('other', { id: 'other' });
  assert.throws(() => workbench.answer('other', 7, { format: 'txt' }), /失效/);
  workbench.answer(task.id, 7, { format: 'txt' });
  assert.deepEqual(client.responses[0].result, { answers: { format: { answers: ['txt'] } } });
  assert.throws(() => workbench.answer(task.id, 7, { format: 'txt' }), /失效/);
});

test('运行锁阻止两个进程实例同时写同一任务登记文件', async () => {
  const file = path.join(await fixture(), 'lock'); const release = await acquireLock(file);
  try { await assert.rejects(acquireLock(file), /已有/); }
  finally { await release(); }
  const nextRelease = await acquireLock(file); await nextRelease();
});

test('HTTP 仅接收本机同源请求，禁止跨站提交与任意静态文件读取', async t => {
  const { workbench } = await setup();
  const access = new AccessStore(workbench.root); await access.start(); t.after(() => access.close());
  const server = createHttpServer(workbench, access);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeStreams(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + '/api/status')).status, 401);
  assert.equal((await fetch(url + '/api/status', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    http.get(url + '/api/status', { headers: { Host: 'untrusted.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(url + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url + '/package.json')).status, 404);
  assert.equal((await fetch(url + '/api/tasks/desktop/send', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Client': '1' }, body: '{"prompt":"hello"}' })).status, 401);
});

test('关闭进度流后立即收到断开通知，不向已经结束的响应写入', async t => {
  const { workbench } = await setup();
  const access = new AccessStore(workbench.root); await access.start(); t.after(() => access.close());
  const session = await access.setup({ code: access.setupCode, username: 'owner', password: 'test-password-only' });
  const server = createHttpServer(workbench, access);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const stream = await fetch(`http://127.0.0.1:${server.address().port}/api/events`, { headers: { Cookie: `codex_link_session=${session.token}` } });
  const reader = stream.body.getReader();
  await reader.read();
  server.closeStreams();
  workbench.emitEvent('connection', { connected: false });
  while (!(await reader.read()).done) {}
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workbench.listenerCount('event'), 0);
});
