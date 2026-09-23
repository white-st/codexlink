import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Workbench } from '../src/workbench.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const originals=await Promise.all(['access.json','registry.json'].map(async name=>[name,sha(await readFile('.runtime/'+name))]));
await mkdir('.runtime/tests',{recursive:true});const root=await mkdtemp(path.resolve('.runtime/tests/live-skills-'));
const workbench=new Workbench({root});const report={root,checkedAt:new Date().toISOString(),passed:false,results:[]};
async function check(skill){
 const task=await workbench.createTask('C063 技能验证 '+skill.title);let timer,handler;
 const done=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Skill test timed out: '+skill.id)),110000);handler=m=>{if(m.method==='turn/completed'&&m.params.threadId===task.id)resolve(m.params.turn);};workbench.client.on('message',handler);});
 try {
  await workbench.send(task.id,'这是一次技能接入验证，不是实际制作任务。请根据本条需求明确指定的技能，回复“SKILL_OK”，以及该技能的完整名称和一条工作要求。不要创建或修改文件，不要安装软件，不要联网，不要执行文档制作或开发。',{skillId:skill.id});
  const turn=await done;assert.equal(turn.status,'completed');const thread=await workbench.readThread(task.id);
  const output=thread.turns.flatMap(t=>t.items||[]).filter(i=>i.type==='agentMessage').map(i=>i.text).join('\n');assert.match(output,/SKILL_OK/);
  report.results.push({id:skill.id,title:skill.title,threadId:task.id,status:turn.status,reply:output});console.log('Live skill accepted: '+skill.id);
 }finally{clearTimeout(timer);workbench.client.off('message',handler);done.catch(()=>{});}
}
try{
 await workbench.start();const skills=await workbench.skills(root);assert.equal(skills.length,5);assert.ok(skills.every(s=>s.available));
 // Bound model work to two independent synthetic tasks at a time.
 for(let i=0;i<skills.length;i+=2)await Promise.all(skills.slice(i,i+2).map(check));
 for(const [name,hash]of originals)assert.equal(sha(await readFile('.runtime/'+name)),hash);
 report.passed=true;report.formalDataUnchanged=true;
}catch(error){report.error=error.message;throw error;}
finally{await workbench.close();await writeFile('.runtime/skills-live-C063.json',JSON.stringify(report,null,2));}
