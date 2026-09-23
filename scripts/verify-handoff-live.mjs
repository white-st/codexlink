import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Workbench } from '../src/workbench.mjs';
import { CodexClient } from '../src/codex-client.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const originals = await Promise.all(['access.json','registry.json'].map(async name => [name, sha(await readFile('.runtime/'+name))]));
await mkdir('.runtime/tests', {recursive:true});
const root = await mkdtemp(path.resolve('.runtime/tests/live-handoff-'));
const workbench = new Workbench({root}); const desktop = new CodexClient();
const report = {root, checkedAt:new Date().toISOString(), passed:false};
async function turn(client, id, action) {
  let handler, timer;
  const complete = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Live turn did not finish')), 55_000);
    handler = message => { if (message.method==='turn/completed' && message.params.threadId===id) resolve(message.params.turn.status); };
    client.on('message', handler);
  });
  try { await action(); assert.equal(await complete,'completed'); }
  finally { clearTimeout(timer); client.off('message',handler); complete.catch(()=>{}); }
}
try {
  await workbench.start(); await desktop.start();
  const a=await workbench.createTask('C058 独立交接验证 A'), b=await workbench.createTask('C058 独立交接验证 B');
  report.tasks=[a.id,b.id];
  await Promise.all([a,b].map(task=>turn(workbench.client,task.id,()=>workbench.send(task.id,'Reply exactly C058_MOBILE_OK. Do not call tools or change files.'))));
  const bPid=workbench.client.sessions.get(b.id).client.child.pid;
  await assert.rejects(desktop.request('thread/resume',{threadId:a.id}), /active writer/);
  await workbench.transfer(a.id,'desktop'); assert.equal(workbench.controlState(a.id),'desktop');
  assert.equal(workbench.client.sessions.has(a.id),false);
  await desktop.request('thread/resume',{threadId:a.id});
  await assert.rejects(desktop.request('thread/resume',{threadId:b.id}), /active writer/);
  assert.equal(workbench.client.sessions.get(b.id).client.child.pid,bPid);
  assert.equal(workbench.client.sessions.get(b.id).client.ready,true);
  await turn(desktop,a.id,()=>desktop.request('turn/start',{threadId:a.id,input:[{type:'text',text:'Reply exactly C058_DESKTOP_OK. Do not call tools or change files.'}],approvalPolicy:'never'}));
  const history=await workbench.readThread(a.id);
  assert.match(JSON.stringify(history.turns),/C058_DESKTOP_OK/);assert.equal(workbench.client.sessions.has(a.id),false);
  await assert.rejects(workbench.transfer(a.id,'mobile'),/电脑仍占用/);
  await desktop.closeAndWait();await workbench.transfer(a.id,'mobile');
  assert.equal(workbench.controlState(a.id),'mobile');assert.equal((await workbench.readThread(a.id)).turns.length,history.turns.length);
  await workbench.writeQueue;
  for (const [name,hash] of originals) assert.equal(sha(await readFile('.runtime/'+name)),hash,'Formal data unchanged');
  Object.assign(report,{passed:true,checks:['active writer before handoff','only original task process exited','independent desktop connection resumed original thread','other task retains its writer and process','actual desktop follow-up completed','mobile reads latest desktop reply without taking writer','resume refused while desktop owns writer','resume after desktop close preserves all turns'],formalDataUnchanged:true});
  console.log('Live handoff, independent writer ownership, other task continuity, read-only history and return to mobile passed.');
} catch (error) { report.error=error.message;throw error; }
finally { await desktop.closeAndWait();await workbench.close();await writeFile('.runtime/handoff-live-C058.json',JSON.stringify(report,null,2)); }
