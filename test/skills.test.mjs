import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Workbench } from '../src/workbench.mjs';
import { AccessStore } from '../src/access-store.mjs';
import { createHttpServer } from '../src/server.mjs';

const names=[['word','documents:documents','documents@openai-primary-runtime'],['ppt','presentations:Presentations','presentations@openai-primary-runtime'],['excel','spreadsheets:Spreadsheets','spreadsheets@openai-primary-runtime'],['pdf','pdf:pdf','pdf@openai-primary-runtime'],['development','development-workflow:development-workflow','development-workflow@personal']];
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
 await mkdir('.runtime/tests',{recursive:true});const root=await mkdtemp(path.resolve('.runtime/tests/skills-'));let index=0;
 const client=new EventEmitter();client.calls=[];client.start=async()=>{};client.close=async()=>{};
 client.catalog=names.map(([id,name,pluginId])=>({name,pluginId,enabled:true,path:path.join(root,'installed',id,'SKILL.md')}));
 client.request=async(method,params)=>{
  client.calls.push({method,params});
  if(method==='account/read')return {account:{}};if(method==='model/list')return {data:[]};
  if(method==='thread/start'||method==='thread/resume')return {thread:{id:params.threadId||'skills-'+ ++index}};
  if(method==='skills/list'){if(client.wait)await client.wait.promise;if(client.failure)throw Error('private runtime path');return client.result??{data:[{cwd:params.cwds[0],skills:client.catalog,errors:[]}]};}
  if(method==='turn/start'){const turn={id:'turn-'+ ++index,status:'completed'};client.emit('message',{method:'turn/completed',params:{threadId:params.threadId,turn}});return {turn};}
  return {};
 };
 const workbench=new Workbench({root,client});await workbench.start();const access=new AccessStore(root);await access.start();
 const owner=await access.setup({code:access.setupCode,username:'skills_owner',password:'test-skills-password'});
 await access.createUser(owner.user.id,{username:'skills_other',password:'test-skills-password',level:1});const other=await access.login({username:'skills_other',password:'test-skills-password'});
 const server=createHttpServer(workbench,access);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const call=async(route,input,token=owner.token)=>{const r=await fetch(origin+'/api'+route,{method:input===undefined?'GET':'POST',headers:{Cookie:'codex_link_session='+token,...(input===undefined?{}:{'Content-Type':'application/json','X-Local-Client':'1'})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,data:await r.json()};};
 const project=(await call('/projects',{name:'技能项目',level:0})).data;const task=(await call('/tasks',{projectId:project.id,name:'技能任务'})).data;
 t.after(async()=>{client.wait?.resolve();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));await workbench.close();await access.close();});
 return {root,client,workbench,access,owner,other,call,origin,project,task};
}
test('技能列表仅返回五个安全标识；发送使用真实名称和路径，旧请求不变',async t=>{
 const f=await fixture(t);const list=await f.call(`/tasks/${f.task.id}/skills`);assert.equal(list.status,200);assert.deepEqual(list.data.skills.map(s=>s.id),names.map(n=>n[0]));assert.ok(list.data.skills.every(s=>s.available));assert.doesNotMatch(JSON.stringify(list.data),/SKILL.md|pluginId|installed/);
 for(const [id,name] of names){const r=await f.call(`/tasks/${f.task.id}/send`,{prompt:'测试需求',skillId:id});assert.equal(r.status,200);const p=f.client.calls.filter(c=>c.method==='turn/start').at(-1).params;assert.equal(p.input[0].text,`$${name}\n测试需求`);assert.deepEqual(p.input[1],{type:'skill',name,path:path.join(f.root,'installed',id,'SKILL.md')});}
 const before=f.client.calls.filter(c=>c.method==='skills/list').length;assert.equal((await f.call(`/tasks/${f.task.id}/send`,{prompt:'普通需求'})).status,200);assert.deepEqual(f.client.calls.at(-1).params.input,[{type:'text',text:'普通需求'}]);assert.equal(f.client.calls.filter(c=>c.method==='skills/list').length,before);
});
test('技能禁用、卸载、同名冒充和损坏目录不会静默降级或泄露路径',async t=>{
 const f=await fixture(t);const original={...f.client.catalog[0]};
 for(const change of [{enabled:false},{pluginId:'untrusted@local'},{path:'relative/SKILL.md'},{name:'another'}]){Object.assign(f.client.catalog[0],original,change);const list=await f.call(`/tasks/${f.task.id}/skills`);assert.equal(list.data.skills[0].available,false);const res=await f.call(`/tasks/${f.task.id}/send`,{prompt:'测试',skillId:'word'});assert.equal(res.status,409);}
 Object.assign(f.client.catalog[0],original);f.client.catalog.push({...original});assert.equal((await f.call(`/tasks/${f.task.id}/skills`)).data.skills[0].available,false);f.client.catalog=[];
 assert.equal((await f.call(`/tasks/${f.task.id}/send`,{prompt:'测试',skillId:'word'})).status,409);
 f.client.failure=true;let res=await f.call(`/tasks/${f.task.id}/skills`);assert.equal(res.status,503);assert.doesNotMatch(JSON.stringify(res.data),/private runtime/);
 f.client.failure=false;f.client.result={data:[{cwd:path.join(f.root,'wrong-cwd'),skills:[]}]};assert.equal((await f.call(`/tasks/${f.task.id}/skills`)).status,503);
 assert.equal(f.client.calls.filter(c=>c.method==='turn/start').length,0);
});
test('私有、共享只读、匿名和任意技能参数均不能越权',async t=>{
 const f=await fixture(t);const route=`/tasks/${f.task.id}/skills`;
 assert.equal((await f.call(route,undefined,'')).status,401);assert.equal((await f.call(route,undefined,f.other.token)).status,404);
 await f.call('/projects/'+f.project.id,{shared:true});assert.equal((await f.call(route,undefined,f.other.token)).status,403);assert.equal((await f.call(`/tasks/${f.task.id}/send`,{prompt:'test',skillId:'word'},f.other.token)).status,403);
 for(const extra of [{skillId:'../secret'},{skillId:null},{skillId:['word']},{skillId:{id:'word'}},{skillId:'word',skillPath:'C:/secret'},{skills:[{name:'word',path:'C:/secret'}]}])assert.equal((await f.call(`/tasks/${f.task.id}/send`,{prompt:'test',...extra})).status,400);
 assert.equal(f.client.calls.filter(c=>c.method==='skills/list'||c.method==='turn/start').length,0);
});
test('技能查询中注销不返回结果，发送中注销不创建模型轮次；并发发送受忙碌保护',async t=>{
 const f=await fixture(t);f.client.wait=gate();const lookup=f.call(`/tasks/${f.task.id}/skills`);while(!f.client.calls.some(c=>c.method==='skills/list'))await new Promise(r=>setImmediate(r));f.access.logout(f.owner.token);f.client.wait.resolve();assert.equal((await lookup).status,401);
 const next=await f.access.login({username:'skills_owner',password:'test-skills-password'});f.client.calls=[];f.client.wait=gate();const sending=f.call(`/tasks/${f.task.id}/send`,{prompt:'first',skillId:'word'},next.token);while(!f.client.calls.some(c=>c.method==='skills/list'))await new Promise(r=>setImmediate(r));assert.equal((await f.call(`/tasks/${f.task.id}/send`,{prompt:'race'},next.token)).status,409);f.access.logout(next.token);f.client.wait.resolve();assert.equal((await sending).status,401);assert.equal(f.client.calls.filter(c=>c.method==='turn/start').length,0);
});
test('选技能与上传附件一起发送，只有附件也支持；仅技能仍需填写需求',async t=>{
 const f=await fixture(t);const file=await readFile('test/fixtures/attachments/演示文稿.pptx');const r=await fetch(f.origin+`/api/tasks/${f.task.id}/attachments?name=demo.pptx`,{method:'POST',headers:{Cookie:'codex_link_session='+f.owner.token,'X-Local-Client':'1','Content-Type':'application/octet-stream'},body:file});assert.equal(r.status,201);const uploaded=await r.json();
 const res=await f.call(`/tasks/${f.task.id}/send`,{prompt:'',attachments:[uploaded.name],skillId:'ppt'});assert.equal(res.status,200);const input=f.client.calls.filter(c=>c.method==='turn/start').at(-1).params.input;assert.match(input[0].text,/attachments\//);assert.equal(input[1].name,'presentations:Presentations');assert.equal((await f.call(`/tasks/${f.task.id}/send`,{prompt:'',skillId:'ppt'})).status,400);
 const image=await readFile('test/fixtures/attachments/vision-fixture.png');const photo=await fetch(f.origin+`/api/tasks/${f.task.id}/attachments?name=photo.png`,{method:'POST',headers:{Cookie:'codex_link_session='+f.owner.token,'X-Local-Client':'1','Content-Type':'application/octet-stream'},body:image});assert.equal(photo.status,201);const picture=await photo.json();
 assert.equal((await f.call(`/tasks/${f.task.id}/send`,{prompt:'根据图片制作演示',attachments:[uploaded.name,picture.name],skillId:'ppt'})).status,200);const mixed=f.client.calls.filter(c=>c.method==='turn/start').at(-1).params.input;
 assert.equal(mixed[0].type,'text');assert.match(mixed[0].text,/demo.pptx/);assert.equal(mixed[1].type,'skill');assert.equal(mixed[1].name,'presentations:Presentations');assert.deepEqual(mixed[2],{type:'localImage',path:path.join(f.access.data.projects[0].cwd,picture.name)});
});
