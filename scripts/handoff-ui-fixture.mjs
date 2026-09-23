// Loopback-only native UI fixture: real HTTP/Portal/Workbench, simulated Codex workers.
// Test authentication is injected here only; no real credentials or product data are used.
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Workbench } from '../src/workbench.mjs';
import { CodexSessions } from '../src/codex-sessions.mjs';
import { AccessStore } from '../src/access-store.mjs';
import { Portal } from '../src/portal.mjs';
import { createHttpServer } from '../src/server.mjs';
await mkdir('.runtime/tests',{recursive:true});
const root=await mkdtemp(path.resolve('.runtime/tests/handoff-ui-'));const events=[];let next=0;
const record=async(type,data)=>{events.push({type,at:new Date().toISOString(),data});await writeFile('.runtime/handoff-ui-C058.json',JSON.stringify({root,events},null,2));};
class FixtureClient extends EventEmitter {
  async start(){this.ready=true;}
  async request(method,params){
    if(method==='account/read')return {account:{}};
    if(method==='model/list')return {data:[]};
    if(method==='thread/start')return {thread:{id:'handoff-ui-'+ ++next}};
    if(method==='thread/resume')return {thread:{id:params.threadId}};
    if(method==='thread/read')return {thread:{id:params.threadId,status:{type:'idle'},turns:[{id:'fixture-completed',status:'completed',items:[{type:'agentMessage',text:'这是一条已完成的测试对话，可以从右上角更多菜单交给电脑。'}]}]}};
    return {};
  }
  async closeAndWait(){this.ready=false;}
  respond(){} rejectRequest(){}
}
const workbench=new Workbench({root,client:new CodexSessions({factory:()=>new FixtureClient()})});await workbench.start();
const access=new AccessStore(root);await access.start();
const owner=await access.setup({code:access.setupCode,username:'handoff_fixture',password:'fixture-only-058'});
const portal=new Portal(workbench,access);
const project=await portal.createProject(owner.user.id,{name:'电脑交接验收',level:0});
await portal.createTask(owner.user.id,{name:'交给电脑的任务',projectId:project.id});
await portal.createTask(owner.user.id,{name:'另一条手机任务',projectId:project.id});
workbench.on('event',event=>{if(event.type==='task')void record('control-state',{taskId:event.data.id,target:event.data.controlTarget||'mobile',control:workbench.controlState(event.data.id)});});
const server=createHttpServer(workbench,access);const requestHandler=server.listeners('request')[0];server.removeAllListeners('request');
server.on('request',(req,res)=>{
 if(req.url==='/__test/stop'&&req.method==='POST'){res.end('stopped');setTimeout(async()=>{server.closeStreams();server.closeAllConnections();server.close();await workbench.close();await access.close();},100);return;}
 req.headers.cookie='codex_link_session='+owner.token;
 if(req.url.endsWith('/transfer'))void record('transfer-request',{route:req.url});
 requestHandler(req,res);
});
server.listen(47816,'127.0.0.1',()=>console.log('Isolated native handoff fixture ready on 127.0.0.1:47816'));
