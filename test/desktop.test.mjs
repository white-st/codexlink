import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { DesktopIpc, patchState } from '../src/desktop-ipc.mjs';
import { DesktopClient } from '../src/desktop-client.mjs';
import { CodexSessions } from '../src/codex-sessions.mjs';
import { Workbench } from '../src/workbench.mjs';

const delay = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function state(cwd = process.cwd(), status = 'completed', id = 'old') {
  return { id: 'thread', cwd, requests: [], unconfirmedTurnSubmissions: [], threadRuntimeStatus: { type: status === 'inProgress' ? 'active' : 'idle' },
    turnHistory: { kind: 'canonical', history: { entitiesByKey: { [id]: { turnId: id, status, items: [{ type: 'agentMessage', text: '中文回复' }] } },
      islands: [{ entries: [{ value: id }], newerBoundary: { status: 'exhausted' } }] } } };
}
function wire() {
  const input = new PassThrough(), calls = [];
  const output = new Writable({ write(bytes, _, done) {
    const message = JSON.parse(bytes.subarray(4)); calls.push(message);
    queueMicrotask(() => handler(message)); done();
  } });
  let handler = m => {
    if (m.type !== 'request') return;
    if (m.method === 'initialize') reply(m, { clientId: 'me' }, 'me');
    if (m.method === 'thread-owner-discovery') reply(m, { supportsUntrustedAppInput: true });
    if (m.method === 'thread-follower-load-complete-history') {
      snapshot(1, { ...state(), turns: [] }); snapshot(2, state()); reply(m, { revision: 2 });
    }
  };
  function send(value) {
    const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(4); head.writeUInt32LE(body.length);
    const bytes = Buffer.concat([head, body]);
    for (let i = 0; i < bytes.length; i += 3) input.write(bytes.subarray(i, i + 3));
  }
  function reply(m, result, owner = 'owner') { send({ type: 'response', requestId: m.requestId, method: m.method, handledByClientId: owner, resultType: 'success', result }); }
  function change(value, owner = 'owner') { send({ type: 'broadcast', sourceClientId: owner, method: 'thread-stream-state-changed', version: 11, params: { hostId: 'local', conversationId: 'thread', change: value } }); }
  function snapshot(revision, conversationState) { change({ type: 'snapshot', revision, conversationState }); }
  const transport = { input, output, close() { this.closed = true; } };
  return { calls, transport, send, reply, change, snapshot, set handler(h) { handler = h; } };
}

test('桌面帧可分片，历史锚定到确认版本，后续补丁与中文保持一致', async () => {
  const w = wire(), ipc = new DesktopIpc({ transport: () => w.transport });
  await ipc.open('thread'); assert.equal(ipc.revision, 2); assert.equal(ipc.owner, 'owner');
  w.change({ type: 'patches', revision: 3, patches: [{ op: 'replace', path: ['cwd'], value: 'changed' }] });
  assert.equal(ipc.state.cwd, 'changed');
  assert.equal(w.calls.filter(c => c.method === 'thread-follower-load-complete-history').length, 1);
  w.send({ type: 'client-discovery-request', requestId: 'unknown' }); await delay();
  assert.equal(w.calls.at(-1).response.canHandle, false); ipc.close(); assert.equal(w.transport.closed, true);
});

test('错 owner、版本间隙和原型路径均使连接失效，不能继续发送', async () => {
  for (const fault of ['owner', 'gap', 'prototype']) {
    const w = wire(), ipc = new DesktopIpc({ transport: () => w.transport }); await ipc.open('thread');
    if (fault === 'owner') w.change({ type: 'snapshot', revision: 3, conversationState: state() }, 'imposter');
    if (fault === 'gap') w.snapshot(4, state());
    if (fault === 'prototype') w.change({ type: 'patches', revision: 3, patches: [{ op: 'add', path: ['__proto__', 'polluted'], value: true }] });
    assert.ok(ipc.failure); await assert.rejects(ipc.request('turn', 1, {}, { mutation: true }));
  }
  assert.equal({}.polluted, undefined);
  assert.deepEqual(patchState({ a: [1, 2] }, [{ op: 'remove', path: ['a', 0] }, { op: 'add', path: ['a', 1], value: 3 }]), { a: [2, 3] });
});

test('发送响应超时、断线或错误 owner 都只提交一次并报告结果未知', async () => {
  for (const fault of ['timeout', 'disconnect', 'owner']) {
    const w = wire(), ipc = new DesktopIpc({ transport: () => w.transport, timeoutMs: 10 }); await ipc.open('thread');
    w.handler = m => { if (m.method === 'start') { if (fault === 'disconnect') w.transport.input.emit('end'); if (fault === 'owner') w.reply(m, {}, 'imposter'); } };
    await assert.rejects(ipc.request('start', 2, {}, { mutation: true }), e => e.code === 'RPC_TIMEOUT' && e.statusCode === 503);
    assert.equal(w.calls.filter(c => c.method === 'start').length, 1); ipc.close();
  }
});

class Ipc extends EventEmitter {
  constructor(cwd) { super(); this.state = state(cwd); this.calls = []; }
  async open() {}
  async request(method, version, params, options) { this.calls.push({ method, version, params, options }); return this.handler?.(method, params) || { result: { result: { turn: { id: 'new' } } } }; }
  update(value) { this.state = value; this.emit('state'); }
  close() { this.closed = true; }
}
async function adapter(t) {
  const ipc = new Ipc(process.cwd()), client = new DesktopClient({ ipc: () => ipc }), events = [];
  client.on('message', e => events.push(e)); await client.start(); await client.request('thread/resume', { threadId: 'thread', cwd: process.cwd() });
  t.after(() => client.closeAndWait()); return { ipc, client, events };
}

test('同会话输入继承桌面配置；旧完成快照不清除新一轮，历史与确认提示同步', async t => {
  const { ipc, client, events } = await adapter(t);
  const input = [{ type: 'text', text: '中文' }, { type: 'localImage', path: 'checked.png' }, { type: 'skill', name: 'test', path: 'checked/SKILL.md' }];
  await client.request('turn/start', { threadId: 'thread', cwd: process.cwd(), input, approvalPolicy: 'never' });
  assert.equal(events.length, 0);
  assert.deepEqual(ipc.calls[0].params.turnStart.request.input, [{ ...input[0], text_elements: [] }, ...input.slice(1)]);
  assert.equal(input[0].text_elements, undefined); // Do not mutate the caller's draft.
  assert.deepEqual(ipc.calls[0].params.turnStart.context, { inheritThreadSettings: true });
  const running = state(process.cwd(), 'inProgress', 'new'); running.requests.push({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread' } });
  ipc.update(running); assert.equal(events.at(-1).params.waiting, true);
  assert.equal(events.some(e => 'id' in e), false); // Desktop confirmation is never auto-approved/declined.
  ipc.update(state(process.cwd(), 'completed', 'new'));
  assert.equal(events.filter(e => e.method === 'turn/completed').length, 1);
  assert.equal((await client.request('thread/read', { threadId: 'thread' })).thread.turns.at(-1).items[0].text, '中文回复');
});

test('电脑运行期间拒绝重复发送，停止必须匹配真实轮次，工作目录变化拒绝输入', async t => {
  const { ipc, client } = await adapter(t);
  ipc.update(state(process.cwd(), 'inProgress', 'desktop-turn'));
  await assert.rejects(client.request('turn/start', { threadId: 'thread', cwd: process.cwd() }), e => e.code === 'DESKTOP_BUSY');
  await assert.rejects(client.request('turn/interrupt', { threadId: 'thread', turnId: 'stale' }));
  assert.equal(ipc.calls.length, 0);
  await client.request('turn/interrupt', { threadId: 'thread', turnId: 'desktop-turn' });
  assert.equal(ipc.calls[0].params.expectedTurnId, 'desktop-turn');
  ipc.update(state(path.dirname(process.cwd())));
  await assert.rejects(client.request('turn/start', { threadId: 'thread', cwd: process.cwd(), input: [{ type: 'text', text: 'test' }] }));
  assert.equal(ipc.calls.length, 1);
});

test('未知的发送结果不会被旧已完成轮次核销，也不自动重发', async t => {
  const { ipc, client } = await adapter(t);
  ipc.handler = () => { throw Object.assign(Error('unconfirmed'), { code: 'RPC_TIMEOUT' }); };
  await assert.rejects(client.request('turn/start', { threadId: 'thread', cwd: process.cwd(), input: [{ type: 'text', text: 'test' }] }));
  assert.equal((await client.request('thread/read', { threadId: 'thread' })).thread.pendingSubmission, true);
  await assert.rejects(client.request('turn/start', { threadId: 'thread', cwd: process.cwd() }));
  assert.equal(ipc.calls.length, 1);
  ipc.update(state(process.cwd(), 'completed', 'confirmed'));
  assert.equal((await client.request('thread/read', { threadId: 'thread' })).thread.pendingSubmission, false);
});

test('桌面文本具备显示必需字段，已有标注、中文、多文本与图片技能保留', async t => {
  const { ipc, client } = await adapter(t);
  const annotation = [{ byteRange: { start: 0, end: 3 }, placeholder: '文' }];
  const input = [{ type: 'text', text: '中文' }, { type: 'localImage', path: 'checked.png' },
    { type: 'text', text: '文', text_elements: annotation }, { type: 'skill', name: 'test', path: 'checked/SKILL.md' }];
  const before = structuredClone(input);
  await client.request('turn/start', { threadId: 'thread', cwd: process.cwd(), input });
  const sent = ipc.calls[0].params.turnStart.request.input;
  assert.deepEqual(sent.filter(i => i.type === 'text').map(i => i.text_elements.length), [0, 1]);
  assert.equal(sent[0].text, '中文'); assert.deepEqual(sent[1], before[1]); assert.deepEqual(sent[3], before[3]);
  assert.deepEqual(input, before); sent[2].text_elements[0].byteRange.end = 999;
  assert.equal(annotation[0].byteRange.end, 3);
});

test('无效文本标注在桌面提交前拒绝，未发送不进入结果未知状态', async t => {
  const { ipc, client } = await adapter(t);
  await assert.rejects(client.request('turn/start', { threadId: 'thread', cwd: process.cwd(), input: [{ type: 'text', text: 'test', text_elements: {} }] }), /标注格式/);
  assert.equal(ipc.calls.length, 0); assert.equal(client.submissionUncertain, undefined);
});

test('桌面忙碌保持运行，未知提交不被历史核销；确认提示来自桌面而不自动回答', async t => {
  await mkdir('.runtime/tests', { recursive: true }); const root = await mkdtemp(path.resolve('.runtime/tests/desktop-busy-'));
  const client = new Worker(), workbench = new Workbench({ root, client }); client.close = () => {};
  t.after(() => workbench.close()); workbench.connected = true;
  const task = { id: 'thread', cwd: root, busy: false, status: 'idle' }; workbench.tasks.set(task.id, task); workbench.loaded.add(task.id);
  client.handler = async () => { throw Object.assign(Error('busy'), { code: 'DESKTOP_BUSY', turnId: 'native' }); };
  await assert.rejects(workbench.send(task.id, 'do not submit'));
  assert.equal(task.busy, true); assert.equal(task.status, 'running'); assert.equal(task.activeTurn, 'native');
  client.emit('message', { method: 'desktop/attention', params: { threadId: task.id, waiting: true } });
  assert.equal(task.status, 'waiting'); assert.equal(workbench.desktopAttention.has(task.id), true);
  task.status = 'unknown'; task.activeTurn = null;
  client.handler = () => ({ thread: { pendingSubmission: true, status: { type: 'idle' }, turns: [{ id: 'old', status: 'completed' }] } });
  await workbench.reconcile(task.id); assert.equal(task.status, 'unknown'); assert.equal(task.busy, true);
});

class Worker extends EventEmitter {
  async start() { this.ready = true; }
  async request(method, params) {
    if (this.handler) return this.handler(method, params);
    if (method === 'account/read') return { account: {} };
    if (method === 'model/list') return { data: [] };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } };
    return { turn: { id: 'new' } };
  }
  async closeAndWait() { this.closeCalled = true; if (this.gate) await this.gate.promise; this.ready = false; this.closed = true; }
}

test('仅恢复时明确占用才连接原 owner，先确认自己进程退出，发送失败不切换重试', async () => {
  const own = new Worker(), desktop = new Worker(); desktop.desktop = true; own.gate = deferred(); let followers = 0;
  const sessions = new CodexSessions({ factory: () => own, desktopFactory: () => { followers++; return desktop; } });
  own.handler = () => { throw Error('already has an active writer'); };
  const pending = sessions.request('thread/resume', { threadId: 'thread', cwd: process.cwd() });
  while (!own.closeCalled) await delay(); assert.equal(followers, 0); own.gate.resolve(); await pending;
  assert.equal(followers, 1); assert.equal(sessions.isDesktopThread('thread'), true);
  desktop.handler = () => { throw Object.assign(Error('uncertain'), { code: 'RPC_TIMEOUT' }); };
  await assert.rejects(sessions.request('turn/start', { threadId: 'thread' })); assert.equal(followers, 1); await sessions.close();
  const broken = new CodexSessions({ factory: () => { const w = new Worker(); w.handler = () => { throw Error('different failure'); }; return w; }, desktopFactory: () => { throw Error('must not happen'); } });
  await assert.rejects(broken.request('thread/resume', { threadId: 'thread' }), /different failure/); await broken.close();
});

test('先收到完成事件也必须等发送响应才释放；下一次发送等退出，桌面 follower 不释放', async t => {
  await mkdir('.runtime/tests', { recursive: true }); const root = await mkdtemp(path.resolve('.runtime/tests/desktop-idle-'));
  const workers = [], client = new CodexSessions({ autoReleaseIdle: true, factory: () => { const w = new Worker(); workers.push(w); return w; } });
  const workbench = new Workbench({ root, client }); await workbench.start(); t.after(() => workbench.close());
  const task = await workbench.createTask('idle'); const worker = workers[1], response = deferred();
  worker.gate = deferred(); worker.handler = async method => {
    if (method === 'turn/start') {
      worker.emit('message', { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'new' } } });
      worker.emit('message', { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'new', status: 'completed' } } });
      await response.promise; return { turn: { id: 'new' } };
    }
  };
  const send = workbench.send(task.id, 'test'); while (task.status !== 'completed') await delay();
  assert.equal(worker.closeCalled, undefined);
  await assert.rejects(workbench.send(task.id, 'response still pending'), e => e.statusCode === 409);
  response.resolve(); while (!worker.closeCalled) await delay();
  const next = workbench.send(task.id, 'next'); await delay(); assert.equal(workers.length, 2);
  worker.gate.resolve(); await send; await next; assert.equal(workers.length, 3);
  workers[2].desktop = true; task.busy = false; await workbench.releaseIdle(task); assert.equal(workers[2].closeCalled, undefined);
});
