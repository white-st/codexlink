import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { CodexSessions } from '../src/codex-sessions.mjs';
import { Workbench } from '../src/workbench.mjs';
import { AccessStore } from '../src/access-store.mjs';
import { createHttpServer } from '../src/server.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
class Worker extends EventEmitter {
  constructor(number) { super(); this.number=number; this.calls=[]; this.responses=[]; this.closed=false; }
  async start() { this.ready=true; }
  async request(method, params) {
    this.calls.push({method,params});
    if (this.handler) return this.handler(method,params);
    if (method === 'thread/start' || method === 'thread/resume') return {thread:{id:params.threadId || `thread-${this.number}`}};
    if (method === 'thread/read') return {thread:{id:params.threadId,turns:[{id:'done',status:'completed'}],status:{type:'idle'}}};
    if (method === 'turn/start') return {turn:{id:'turn-1'}};
    if (method === 'account/read') return {account:{}};
    if (method === 'model/list') return {data:[]};
    return {};
  }
  respond(id,result) { this.responses.push({id,result}); }
  rejectRequest(id,message) { this.responses.push({id,message}); }
  async closeAndWait() { this.closeCalled=true; if (this.closeGate) await this.closeGate.promise; this.closed=true; this.ready=false; this.emit('disconnected',Error('closed')); }
}
async function fixture(t) {
  await mkdir('.runtime/tests',{recursive:true}); const root=await mkdtemp(path.resolve('.runtime/tests/handoff-'));
  const workers=[];const client=new CodexSessions({factory:()=>{const worker=new Worker(workers.length);workers.push(worker);return worker;}});
  const workbench=new Workbench({root,client}); await workbench.start();
  const access=new AccessStore(root);await access.start();
  const owner=await access.setup({code:access.setupCode,username:'owner',password:'test-handoff-password'});
  const viewer=await access.createUser(owner.user.id,{username:'viewer',password:'test-handoff-password',level:1});
  const other=await access.login({username:'viewer',password:'test-handoff-password'},'fixture');
  const server=createHttpServer(workbench,access);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const call=async(route,input,token=owner.token)=>{const r=await fetch(origin+'/api'+route,{method:input===undefined?'GET':'POST',headers:{Cookie:'codex_link_session='+token,...(input===undefined?{}:{'Content-Type':'application/json','X-Local-Client':'1'})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,data:await r.json()};};
  const project=(await call('/projects',{name:'交接项目',level:0})).data;
  const a=(await call('/tasks',{projectId:project.id,name:'原任务'})).data;
  const b=(await call('/tasks',{projectId:project.id,name:'其他任务'})).data;
  t.after(async()=>{for(const worker of workers)worker.closeGate?.resolve();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await workbench.close();await access.close();});
  return {root,workbench,access,client,workers,call,origin,owner,other,viewer,project,a,b};
}

test('释放只关闭对应进程，完成前不报成功；读取不重连，恢复不发送轮次',async t=>{
  const f=await fixture(t);const worker=f.workers[1]; worker.closeGate=deferred();
  const release=f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop'});
  while(!worker.closeCalled)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.workbench.controlState(f.a.id),'changing');
  assert.equal(f.workers[2].closed,false);
  assert.equal((await f.call(`/tasks/${f.a.id}/send`,{prompt:'race'})).status,409);
  assert.equal((await f.call(`/tasks/${f.b.id}/send`,{prompt:'other task'})).status,200);
  worker.closeGate.resolve();const result=await release;
  assert.equal(result.status,200);assert.equal(result.data.task.control,'desktop');assert.equal(worker.closed,true);assert.equal(f.workers[2].closed,false);
  const count=f.workers.length;
  assert.equal((await f.call('/history/'+f.a.id)).status,200);assert.equal(f.workers.length,count);
  assert.equal((await f.call(`/tasks/${f.a.id}/send`,{prompt:'blocked'})).status,409);
  assert.equal((await f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop'})).status,200);
  assert.equal((await f.call(`/tasks/${f.a.id}/transfer`,{target:'mobile'})).status,200);
  assert.equal(f.workers.length,count+1);
  assert.equal(f.workers.at(-1).calls.some(c=>c.method==='turn/start'),false);
  assert.equal((await f.call(`/tasks/${f.a.id}/send`,{prompt:'resume send'})).status,200);
});

test('私有、共享只读与匿名不能交接；运行、未知、追问和正在上传拒绝交接',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop'},'')).status,401);
  assert.equal((await f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop'},f.other.token)).status,404);
  await f.call('/projects/'+f.project.id,{shared:true});
  assert.equal((await f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop'},f.other.token)).status,403);
  assert.equal((await f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop',threadId:f.b.id})).status,400);
  const task=f.workbench.task(f.a.id);
  for(const status of ['running','waiting','waiting-input','unknown']){task.status=status;assert.equal((await f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop'})).status,409);}
  task.status='completed';f.workbench.questions.set('q',{taskId:task.id});assert.equal((await f.call(`/tasks/${task.id}/transfer`,{target:'desktop'})).status,409);f.workbench.questions.clear();
  const finish=f.workbench.beginUpload(task.id);assert.equal((await f.call(`/tasks/${task.id}/transfer`,{target:'desktop'})).status,409);finish();
  assert.equal(f.workers[1].closeCalled,undefined);
});

test('上传从收包期间起阻止交接，完成后交接成功且旧上传入口拒绝',async t=>{
  const f=await fixture(t);const bytes=await readFile('test/fixtures/attachments/演示文稿.pptx');
  let request;
  const response=new Promise((resolve,reject)=>{request=http.request(f.origin+`/api/tasks/${f.a.id}/attachments?name=test.pptx`,{method:'POST',headers:{Cookie:'codex_link_session='+f.owner.token,'X-Local-Client':'1','Content-Type':'application/octet-stream','Content-Length':bytes.length}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});request.on('error',reject);request.write(bytes.subarray(0,10));});
  while(!f.workbench.uploads.has(f.a.id))await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop'})).status,409);
  request.end(bytes.subarray(10));assert.equal(await response,201);
  assert.equal(f.workbench.uploads.size,0);
  assert.equal((await f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop'})).status,200);
  const rejected=await fetch(f.origin+`/api/tasks/${f.a.id}/attachments?name=test.pptx`,{method:'POST',headers:{Cookie:'codex_link_session='+f.owner.token,'X-Local-Client':'1','Content-Type':'application/octet-stream'},body:bytes});assert.equal(rejected.status,409);
});

test('会话占用时恢复失败；关闭失败保持待核实，持久化失败不关闭连接',async t=>{
  const f=await fixture(t);const worker=f.workers[1];
  worker.closeGate=deferred();worker.closeGate.reject(Error('exit not confirmed'));
  // Observe rejection only when release starts, without an unhandled rejection.
  worker.closeGate.promise.catch(()=>{});
  assert.equal((await f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop'})).status,400);
  assert.equal(f.workbench.controlState(f.a.id),'release-pending');
  worker.emit('disconnected',Error('stream failed but exit not confirmed'));
  assert.equal(f.workbench.controlState(f.a.id),'release-pending');
  assert.equal((await f.call(`/tasks/${f.a.id}/send`,{prompt:'blocked'})).status,409);
  delete worker.closeGate;assert.equal((await f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop'})).status,200);
  const factory=f.client.factory;f.client.factory=()=>{const client=factory();client.handler=()=>{throw Error('already has an active writer');};return client;};
  const rejected=await f.call(`/tasks/${f.a.id}/transfer`,{target:'mobile'});assert.equal(rejected.status,409);assert.match(rejected.data.error,/电脑仍占用/);assert.equal(f.workbench.controlState(f.a.id),'desktop');
  const persist=f.workbench.persist;f.workbench.persist=async()=>{throw Error('disk full');};
  assert.equal((await f.call(`/tasks/${f.b.id}/transfer`,{target:'desktop'})).status,400);assert.equal(f.workers[2].closeCalled,undefined);assert.equal(f.workbench.controlState(f.b.id),'mobile');f.workbench.persist=persist;
});

test('重启保留交给电脑的标记，旧任务缺少字段时仍由手机操作',async t=>{
  const f=await fixture(t);await f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop'});
  const record=JSON.parse(await readFile(path.join(f.root,'registry.json'),'utf8'));
  assert.equal(record.version,1);assert.equal(record.tasks.find(x=>x.id===f.a.id).controlTarget,'desktop');assert.equal(record.tasks.find(x=>x.id===f.b.id).controlTarget,undefined);
  await f.workbench.close();const restarted=new Workbench({root:f.root,client:new CodexSessions({factory:()=>new Worker(99)})});await restarted.start();t.after(()=>restarted.close());
  assert.equal(restarted.controlState(f.a.id),'desktop');assert.equal(restarted.controlState(f.b.id),'mobile');assert.equal(restarted.client.sessions.size,0);
});

test('不同任务相同 RPC 请求编号隔离，单任务断线不让其他任务离线',async t=>{
  const f=await fixture(t);
  for(const worker of f.workers.slice(1))worker.emit('message',{id:7,method:'item/tool/requestUserInput',params:{threadId:`thread-${worker.number}`,questions:[{id:'q',question:'确认'}]}});
  assert.equal(f.workbench.questions.size,2);
  for(const q of [...f.workbench.questions.values()])f.workbench.answer(q.taskId,q.id,{q:'yes'});
  for(const worker of f.workers.slice(1)){assert.equal(worker.responses[0].id,7);assert.equal(worker.responses.length,1);}
  const task=f.workbench.task(f.a.id);task.busy=true;task.status='starting';
  f.workers[1].emit('disconnected',Error('lost'));
  assert.equal(task.status,'unknown');assert.equal(f.workbench.connected,true);assert.equal(f.workbench.loaded.has(f.b.id),true);
});

test('交接落盘期间注销会阻止关闭；未生成对话的任务给出明确提示',async t=>{
  const f=await fixture(t);const write=deferred(),entered=deferred();const persist=f.workbench.persist.bind(f.workbench);
  f.workbench.persist=async()=>{entered.resolve();await write.promise;return persist();};
  const release=f.call(`/tasks/${f.a.id}/transfer`,{target:'desktop'});await entered.promise;
  f.access.logout(f.owner.token);write.resolve();assert.equal((await release).status,401);
  assert.equal(f.workers[1].closeCalled,undefined);assert.equal(f.workbench.controlState(f.a.id),'release-pending');
  f.workbench.persist=persist;f.workers[2].handler=()=>{throw Error('no rollout found for thread id');};
  await assert.rejects(f.workbench.transfer(f.b.id,'desktop'),/先在手机完成一次对话/);
  assert.equal(f.workers[2].closeCalled,undefined);
});


test('普通发送的会话占用明确返回 409；图片引用保留，释放后只在手动重试时发送',async t=>{
  const f=await fixture(t);const bytes=await readFile('test/fixtures/attachments/vision-fixture.png');
  const upload=await fetch(f.origin+`/api/tasks/${f.a.id}/attachments?name=photo.png`,{method:'POST',headers:{Cookie:'codex_link_session='+f.owner.token,'X-Local-Client':'1','Content-Type':'application/octet-stream'},body:bytes});
  assert.equal(upload.status,201);const file=await upload.json();
  await f.client.releaseThread(f.a.id);f.workbench.loaded.delete(f.a.id);
  const factory=f.client.factory;f.client.factory=()=>{const worker=factory();worker.handler=()=>{throw Error('thread private-id already has an active writer at C:/private/path');};return worker;};
  const payload={prompt:'查看图片',attachments:[file.name]};
  const rejected=await f.call(`/tasks/${f.a.id}/send`,payload);
  assert.equal(rejected.status,409);assert.match(rejected.data.error,/电脑仍占用/);assert.match(rejected.data.error,/手动重试/);
  assert.doesNotMatch(rejected.data.error,/private-id|private\/path|检查服务状态/);
  const task=f.workbench.task(f.a.id);assert.equal(task.status,'failed');assert.equal(task.busy,false);assert.equal(task.error,rejected.data.error);
  assert.equal(f.workbench.loaded.has(task.id),false);assert.equal(f.client.hasThread(task.id),false);
  assert.equal(f.workers.flatMap(w=>w.calls).filter(c=>c.method==='turn/start').length,0);
  const saved=JSON.parse(await readFile(path.join(f.root,'registry.json'),'utf8'));assert.equal(saved.tasks.find(t=>t.id===task.id).error,rejected.data.error);
  assert.equal(f.workers[2].closed,false);f.client.factory=factory;
  assert.equal((await f.call(`/tasks/${task.id}/send`,payload)).status,200);
  const turns=f.workers.flatMap(w=>w.calls).filter(c=>c.method==='turn/start');assert.equal(turns.length,1);assert.equal(turns[0].params.input[1].type,'localImage');
});

test('已归档任务在发送和恢复入口说明原因；不自动取消归档或重发',async t=>{
  const f=await fixture(t);
  await f.client.releaseThread(f.a.id);f.workbench.loaded.delete(f.a.id);
  const factory=f.client.factory;f.client.factory=()=>{const worker=factory();worker.handler=()=>{throw Error('session private-id is archived. Run `codex unarchive private-id` to unarchive it first.');};return worker;};
  const rejected=await f.call(`/tasks/${f.a.id}/send`,{prompt:'继续处理'});
  assert.equal(rejected.status,409);assert.match(rejected.data.error,/已在电脑 Codex 中归档/);assert.match(rejected.data.error,/手动发送/);
  assert.doesNotMatch(rejected.data.error,/private-id|codex unarchive|检查服务状态/);
  const task=f.workbench.task(f.a.id);assert.equal(task.busy,false);assert.equal(task.status,'failed');
  assert.equal(f.workbench.loaded.has(task.id),false);assert.equal(f.client.hasThread(task.id),false);
  task.controlTarget='desktop';
  const restored=await f.call(`/tasks/${task.id}/transfer`,{target:'mobile'});
  assert.equal(restored.status,409);assert.match(restored.data.error,/归档/);assert.equal(task.controlTarget,'desktop');
  assert.equal(f.workers.flatMap(w=>w.calls).some(c=>['thread/unarchive','turn/start'].includes(c.method)),false);
  assert.equal(f.workers[2].closed,false);
  f.client.factory=factory;task.controlTarget='mobile';
  assert.equal((await f.call(`/tasks/${task.id}/send`,{prompt:'恢复后手动发送'})).status,200);
  assert.equal(f.workers.flatMap(w=>w.calls).filter(c=>c.method==='turn/start').length,1);
});

test('非归档的未知恢复错误仍不向网页泄露原始诊断',async t=>{
  const f=await fixture(t);await f.client.releaseThread(f.a.id);f.workbench.loaded.delete(f.a.id);
  const factory=f.client.factory;f.client.factory=()=>{const worker=factory();worker.handler=()=>{throw Error('cannot read C:/private/secret.json');};return worker;};
  const response=await f.call(`/tasks/${f.a.id}/send`,{prompt:'继续处理'});
  assert.equal(response.status,400);assert.equal(response.data.error,'操作失败，请在本机检查服务状态');
  assert.equal(f.workers.flatMap(w=>w.calls).some(c=>c.method==='turn/start'),false);
});
