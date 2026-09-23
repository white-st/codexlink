import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { AccessStore } from '../src/access-store.mjs';
import { Workbench } from '../src/workbench.mjs';
import { createHttpServer } from '../src/server.mjs';

// Real authenticated HTTP → native Codex → project artifact verification.
// All app accounts, bindings and generated files belong to a disposable fixture.
const serve = process.argv.includes('--serve-ui');
const original = await readFile('.runtime/registry.json', 'utf8');
await mkdir('.runtime/tests', { recursive: true });
const root = await mkdtemp(path.resolve('.runtime/tests/live-execution-'));
const access = new AccessStore(root), workbench = new Workbench({ root });
const report = { checkedAt: new Date().toISOString(), fixture: root, checks: [], passed: false };
let server, url;
async function call(route, token, input) {
  const response = await fetch(url + '/api' + route, { method: input === undefined ? 'GET' : 'POST',
    headers: { Cookie: `codex_link_session=${token || ''}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'X-Local-Client': '1' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const text = await response.text(); let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, cookie: response.headers.get('set-cookie') };
}
async function until(operation, description, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await operation()) return; await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error('等待超时：' + description);
}
try {
  await access.start(); await workbench.start();
  server = createHttpServer(workbench, access);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  const password = serve ? 'local-verification-only-2026' : randomBytes(24).toString('base64url');
  const owner = await access.setup({ code: access.setupCode, username: 'test_owner', password });
  const other = await access.createUser(owner.user.id, { username: 'test_other', password, level: 1 });
  let otherSession = await access.login({ username: 'test_other', password });
  const createdProject = await call('/projects', owner.token, { name: '账号文件可见性实机验证', level: 3 });
  assert.equal(createdProject.status, 201);
  const project = createdProject.data;
  const createdTask = await call('/tasks', owner.token, { name: '生成与继续修改文件', projectId: project.id });
  assert.equal(createdTask.status, 201, JSON.stringify(createdTask.data));
  const task = createdTask.data; report.taskId = task.id;
  assert.equal(task.connectedToCodex, true);
  assert.equal((await call(`/history/${task.id}`, owner.token)).status, 200);
  report.checks.push('new-native-task-and-empty-history');
  for (const [step, value] of [[1, 'ACCOUNT-FILES-STEP-1'], [2, 'ACCOUNT-FILES-STEP-2']]) {
    const sent = await call(`/tasks/${task.id}/send`, owner.token, { prompt: `This is an authorized integration test in this task's project. ${step === 1 ? 'Create' : 'Replace'} result.txt with exactly ${value}, no newline. Use local tools to write the file. Do not inspect any other directory or delegate. Reply briefly when done.` });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    await until(() => !workbench.tasks.get(task.id).busy, `file step ${step}`);
    assert.equal(workbench.tasks.get(task.id).status, 'completed', workbench.tasks.get(task.id).error);
    const file = await call(`/tasks/${task.id}/file?name=result.txt`, owner.token);
    assert.equal(file.status, 200); assert.equal(file.data, value);
    report.checks.push(`real-native-file-step-${step}`);
    console.log(`文件生成步骤 ${step} 已通过。`);
  }
  const history = await call(`/history/${task.id}`, owner.token);
  assert.ok(history.data.turns.length >= 2);
  for (const route of ['/status', `/history/${task.id}`, `/tasks/${task.id}/files`, `/tasks/${task.id}/file?name=result.txt`]) {
    const res = await call(route, otherSession.token);
    if (route === '/status') assert.equal(res.data.tasks.length, 0); else assert.equal(res.status, 404);
  }
  await call(`/projects/${project.id}`, owner.token, { shared: true });
  assert.equal((await call(`/tasks/${task.id}/file?name=result.txt`, otherSession.token)).status, 404);
  await access.updateUser(owner.user.id, other.id, { level: 3 });
  otherSession = await access.login({ username: 'test_other', password });
  assert.equal((await call(`/tasks/${task.id}/file?name=result.txt`, otherSession.token)).data, 'ACCOUNT-FILES-STEP-2');
  for (const action of ['send', 'answer', 'stop']) assert.equal((await call(`/tasks/${task.id}/${action}`, otherSession.token, { prompt: 'modify' })).status, 403);
  await call(`/projects/${project.id}`, owner.token, { shared: false });
  assert.equal((await call(`/tasks/${task.id}/file?name=result.txt`, otherSession.token)).status, 404);
  report.checks.push('private-hidden-shared-level-read-only-revocation');
  const stopped = await call(`/tasks/${task.id}/send`, owner.token, { prompt: 'For an interrupt test, run a local 45-second sleep then reply done. Do not read or write any files.' });
  assert.equal(stopped.status, 200);
  await until(() => workbench.tasks.get(task.id).activeTurn, 'interruptible turn', 30_000);
  assert.equal((await call(`/tasks/${task.id}/stop`, owner.token, {})).status, 200);
  await until(() => !workbench.tasks.get(task.id).busy, 'interrupted', 30_000);
  assert.equal(workbench.tasks.get(task.id).status, 'interrupted');
  report.checks.push('real-native-stop');
  const native = await workbench.client.request('thread/list', { limit: 100, useStateDbOnly: true, sourceKinds: ['appServer', 'cli', 'vscode', 'exec'] });
  assert.ok(native.data.some(t => t.id === task.id));
  report.checks.push('native-thread-list-discovery');
  assert.equal(await readFile('.runtime/registry.json', 'utf8'), original);
  report.checks.push('production-registry-unchanged'); report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  await writeFile('.runtime/execution-live-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, url }, null, 2));
  if (serve && report.passed) {
    // Intentional local-only fixture for browser checks. No production account is initialized.
    const close = async () => { server.closeStreams(); server.closeAllConnections(); server.close(); await workbench.close(); await access.close(); };
    process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
  } else {
    server?.closeStreams(); server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    await workbench.close(); await access.close();
  }
}
