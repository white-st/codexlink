// Isolated loopback UI fixture. Production authentication and records are untouched.
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Workbench } from '../src/workbench.mjs';
import { CodexSessions } from '../src/codex-sessions.mjs';
import { AccessStore } from '../src/access-store.mjs';
import { Portal } from '../src/portal.mjs';
import { createHttpServer } from '../src/server.mjs';
await mkdir('.runtime/tests',{recursive:true});
const root=await mkdtemp(path.resolve('.runtime/tests/simplify-ui-'));const events=[];let next=0;
const record=async(type,data)=>{events.push({type,at:new Date().toISOString(),data});await writeFile('.runtime/simplify-ui-C062.json',JSON.stringify({root,events},null,2));};
class FixtureClient extends EventEmitter {
  async start(){this.ready=true;}
  async request(method,params){
    if(method==='account/read')return {account:{}};
    if(method==='model/list')return {data:[]};
    if(method==='thread/start')return {thread:{id:'simplify-ui-'+ ++next}};
    if(method==='thread/resume')return {thread:{id:params.threadId}};
    if(method==='thread/read')return {thread:{id:params.threadId,status:{type:'idle'},turns:[{id:'fixture-completed',status:'completed',items:[{type:'agentMessage',text:'项目、对话和文件仍然保留。手机与电脑网页工作台可以继续处理同一项目。'}]}]}};
    return {};
  }
  async closeAndWait(){this.ready=false;}
  respond(){} rejectRequest(){}
}
const workbench=new Workbench({root,client:new CodexSessions({factory:()=>new FixtureClient()})});await workbench.start();
const access=new AccessStore(root);await access.start();
const owner=await access.setup({code:access.setupCode,username:'simplify_fixture',password:'fixture-only-062'});
const portal=new Portal(workbench,access);
const project=await portal.createProject(owner.user.id,{name:'日常工作',level:0});
await portal.createProject(owner.user.id,{name:'学习资料',level:0});
await portal.createTask(owner.user.id,{name:'正常对话',projectId:project.id});
const legacy=await portal.createTask(owner.user.id,{name:'旧版已移交任务',projectId:project.id});
await workbench.transfer(legacy.id,'desktop',{authorize:()=>{}});
const pending=await portal.createTask(owner.user.id,{name:'旧版交接未完成',projectId:project.id});
workbench.tasks.get(pending.id).controlTarget='desktop';await workbench.persist();
// Include a legitimately visible desktop-source project to verify client filtering.
await access.transaction(data=>{data.projects.push({id:'fixture-desktop',name:'不应出现在手机首页的电脑项目',source:'desktop',ownerId:owner.user.id,level:0,shared:false,cwd:path.join(root,'desktop'),createdAt:new Date().toISOString()});});
await record('fixture-ready',{projects:portal.projects(owner.user.id).map(p=>({name:p.name,source:p.source})),tasks:portal.tasks(owner.user.id).map(t=>({id:t.id,name:t.name,control:t.control}))});
const server=createHttpServer(workbench,access);const requestHandler=server.listeners('request')[0];server.removeAllListeners('request');
server.on('request',(req,res)=>{
 if(req.url==='/__test/stop'&&req.method==='POST'){res.end('stopped');setTimeout(async()=>{server.closeStreams();server.closeAllConnections();server.close();await workbench.close();await access.close();},100);return;}
 req.headers.cookie='codex_link_session='+owner.token;
 if(req.url.endsWith('/transfer'))void record('restore-request',{route:req.url});
 requestHandler(req,res);
});
workbench.on('event',event=>{if(event.type==='task')void record('control-state',{taskId:event.data.id,control:workbench.controlState(event.data.id)});});
server.listen(47816,'127.0.0.1',()=>console.log('Isolated simplify UI fixture ready on 127.0.0.1:47816'));
