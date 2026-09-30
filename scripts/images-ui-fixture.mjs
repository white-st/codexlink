// Isolated, loopback-only UI fixture. No real accounts, user data, or Codex execution.
import http from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateAttachment} from '../src/attachments.mjs';
const root='.runtime/images-ui';await mkdir(root,{recursive:true});
const user={id:'upload-ui-owner',username:'上传界面验收',role:'user',level:0};
const project={id:'upload-ui-project',name:'图片上传验收',source:'mobile',owned:true,level:0,shared:false,createdAt:'2026-09-23T00:00:00Z'};
const tasks=['a','b'].map((id,i)=>({id:'upload-ui-'+id,name:i?'其他任务 B':'原任务 A',projectId:project.id,projectName:project.name,source:'mobile',canExecute:true,busy:false,activeTurn:null,status:'idle',createdAt:'2026-09-23T00:00:0'+(2-i)+'Z'}));
let pending=null, uploaded=null,sent=null;const events=[];
const record=async(type,info={})=>{events.push({type,at:new Date().toISOString(),...info});await writeFile(root+'/events.json',JSON.stringify(events,null,2));};
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1:47816');
  if(url.pathname==='/api/auth')return json(res,{user,setupRequired:false});
  if(url.pathname==='/api/status')return json(res,{user,projects:[project],tasks,connected:true,signedIn:true,questions:[]});
  if(url.pathname.startsWith('/api/history/'))return json(res,{turns:[]});
  if(url.pathname==='/downloads/release.json')return json(res,{});
  if(url.pathname==='/api/tasks/upload-ui-a/attachments'){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);const name=url.searchParams.get('name');validateAttachment(name,bytes);
   if(pending)throw Error('Only one fixture upload allowed');
   uploaded={name:'attachments/11111111-1111-4111-8111-111111111111/'+name,originalName:name,size:bytes.length};
   pending=res;await record('upload-body-received',{task:'upload-ui-a',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),name});return;
  }
  if(url.pathname==='/__test/release'&&req.method==='POST'){
   if(!pending)return json(res,{error:'No held upload'},409);json(pending,uploaded,201);pending=null;await record('upload-completed');return json(res,{released:true});
  }
  if(url.pathname.match(/^\/api\/tasks\/upload-ui-[ab]\/send$/)){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);sent={task:url.pathname.split('/')[3],...JSON.parse(Buffer.concat(chunks))};
   if(sent.task!=='upload-ui-a'||sent.attachments?.length!==1||sent.attachments[0]!==uploaded?.name)throw Error('Attachment delivered to wrong task');
   await record('correct-origin-send',sent);return json(res,{turnId:'fixture-only'});
  }
  if(url.pathname.endsWith('/files'))return json(res,uploaded?[uploaded]:[]);
  if(url.pathname==='/__test/status')return json(res,{pending:!!pending,uploaded,sent,events});
  if(url.pathname==='/__test/stop'&&req.method==='POST'){json(res,{stopped:true});setTimeout(()=>{server.closeAllConnections();server.close();},100);return;}
  return json(res,{error:'Fixture route unavailable'},404);
 }catch(error){console.error(error.message);if(!res.headersSent)json(res,{error:error.message},400);else res.end();}
});
server.listen(47816,'127.0.0.1',()=>console.log('Isolated UI fixture ready at 127.0.0.1:47816'));
