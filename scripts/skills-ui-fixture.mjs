// Isolated native UI fixture; no real accounts, project records or model execution.
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Workbench } from '../src/workbench.mjs';
import { CodexSessions } from '../src/codex-sessions.mjs';
import { AccessStore } from '../src/access-store.mjs';
import { Portal } from '../src/portal.mjs';
import { createHttpServer } from '../src/server.mjs';
await mkdir('.runtime/tests',{recursive:true});
const root=await mkdtemp(path.resolve('.runtime/tests/skills-ui-'));const events=[];const histories=new Map();let next=0;
let records=Promise.resolve();
const record=(type,data)=>{events.push({type,at:new Date().toISOString(),data});records=records.then(()=>writeFile('.runtime/skills-ui-C063.json',JSON.stringify({root,events},null,2)));return records;};
const catalog=[['word','documents:documents','documents@openai-primary-runtime'],['ppt','presentations:Presentations','presentations@openai-primary-runtime'],['excel','spreadsheets:Spreadsheets','spreadsheets@openai-primary-runtime'],['pdf','pdf:pdf','pdf@openai-primary-runtime'],['development','development-workflow:development-workflow','development-workflow@personal']].map(([id,name,pluginId])=>({name,pluginId,enabled:true,path:path.join(root,'installed',id,'SKILL.md')}));
class FixtureClient extends EventEmitter {
 async start(){this.ready=true;}
 async request(method,params){
  if(method==='account/read')return {account:{}};
  if(method==='model/list')return {data:[]};
  if(method==='thread/start')return {thread:{id:'skills-ui-'+ ++next}};
  if(method==='thread/resume')return {thread:{id:params.threadId}};
  if(method==='skills/list'){await record('skills-request',{cwd:params.cwds[0]});return {data:[{cwd:params.cwds[0],skills:catalog,errors:[]}]};}
  if(method==='thread/read')return {thread:{id:params.threadId,status:{type:'idle'},turns:histories.get(params.threadId)||[]}};
  if(method==='turn/start'){
   await record('skill-send',{threadId:params.threadId,input:params.input});
   const turn={id:'turn-'+ ++next,status:'completed',items:[{type:'userMessage',content:params.input.filter(i=>i.type==='text')},{type:'agentMessage',text:'已收到本次需求与所选技能。此为界面测试，不生成真实文件。'}]};
   histories.set(params.threadId,[...(histories.get(params.threadId)||[]),turn]);
   this.emit('message',{method:'turn/completed',params:{threadId:params.threadId,turn}});return {turn};
  }
  return {};
 }
 async closeAndWait(){this.ready=false;}
 respond(){} rejectRequest(){}
}
const workbench=new Workbench({root,client:new CodexSessions({factory:()=>new FixtureClient()})});await workbench.start();
const access=new AccessStore(root);await access.start();const owner=await access.setup({code:access.setupCode,username:'skills_fixture',password:'fixture-only-063'});
const portal=new Portal(workbench,access);const project=await portal.createProject(owner.user.id,{name:'技能体验',level:0});
await portal.createTask(owner.user.id,{name:'文档整理',projectId:project.id});await portal.createTask(owner.user.id,{name:'另一项工作',projectId:project.id});
await record('fixture-ready',{projectId:project.id,tasks:portal.tasks(owner.user.id).map(t=>({id:t.id,name:t.name}))});
const server=createHttpServer(workbench,access);const requestHandler=server.listeners('request')[0];server.removeAllListeners('request');
server.on('request',(req,res)=>{
 if(req.url==='/__test/stop'&&req.method==='POST'){res.end('stopped');setTimeout(async()=>{server.closeStreams();server.closeAllConnections();server.close();await workbench.close();await access.close();await records;},100);return;}
 req.headers.cookie='codex_link_session='+owner.token;requestHandler(req,res);
});
server.listen(47816,'127.0.0.1',()=>console.log('Isolated skills UI fixture ready on 127.0.0.1:47816'));
