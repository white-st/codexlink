import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { AccessStore } from '../src/access-store.mjs';
import { Workbench } from '../src/workbench.mjs';
import { createHttpServer } from '../src/server.mjs';
import { isWithin } from '../src/files.mjs';

await mkdir('.runtime/tests', { recursive: true });
const base = await mkdtemp(path.resolve('.runtime/tests/storage-live-'));
const root = path.join(base, 'runtime');
const mobileRoot = path.resolve(process.argv[2] || path.join(base, 'phone'));
await mkdir(root); await writeFile(path.join(root, 'storage.json'), JSON.stringify({ mobileRoot }));
const access = new AccessStore(root), workbench = new Workbench({ root });
const production = await Promise.all(['access.json', 'registry.json'].map(name => readFile(path.join('.runtime', name))));
const report = { checkedAt: new Date().toISOString(), fixture: root, mobileRoot, checks: [], passed: false };
let server, projectDir;
try {
  await access.start(); await workbench.start();
  server = createHttpServer(workbench, access);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const owner = await access.setup({ code: access.setupCode, username: 'storage_check', password: randomBytes(24).toString('base64url') });
  const call = async (route, input) => {
    const response = await fetch(url + '/api' + route, { method: input === undefined ? 'GET' : 'POST',
      headers: { Cookie: `codex_link_session=${owner.token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'X-Local-Client': '1' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const text = await response.text(); assert.ok(response.ok, text);
    return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
  };
  const project = await call('/projects', { name: '自动存储验证', level: 0 });
  projectDir = access.data.projects.find(p => p.id === project.id).cwd;
  assert.ok(isWithin(mobileRoot, projectDir)); assert.equal(isWithin(root, projectDir), false);
  assert.match(path.relative(mobileRoot, projectDir).split(path.sep).join('/'), /^\d{4}-\d{2}-\d{2}\/\d{6}_自动存储验证_[0-9a-f]{8}$/);
  const task = await call('/tasks', { projectId: project.id, name: '验证新存储目录' });
  report.projectDir = projectDir; report.taskId = task.id;
  await call(`/tasks/${task.id}/send`, { prompt: 'This is an authorized storage integration test. In the current project directory only, create storage-check.txt containing exactly PHONE-STORAGE-OK with no newline. Use local file tools. Do not read other directories, create other files, or delegate. Reply briefly when done.' });
  const deadline = Date.now() + 180_000;
  while (workbench.tasks.get(task.id).busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(workbench.tasks.get(task.id).status, 'completed', workbench.tasks.get(task.id).error);
  assert.equal(await call(`/tasks/${task.id}/file?name=storage-check.txt`), 'PHONE-STORAGE-OK');
  assert.equal(await readFile(path.join(projectDir, 'storage-check.txt'), 'utf8'), 'PHONE-STORAGE-OK');
  report.checks.push('authenticated-http-create-project-and-native-task', 'real-codex-write-in-configured-directory', 'authenticated-file-download');
  const thread = await workbench.readThread(task.id); assert.ok(thread.turns.length >= 1);
  report.checks.push('native-history-retained');
  for (const [i, name] of ['access.json', 'registry.json'].entries()) assert.deepEqual(await readFile(path.join('.runtime', name)), production[i]);
  report.productionHashes = production.map(bytes => createHash('sha256').update(bytes).digest('hex'));
  report.checks.push('production-accounts-projects-and-tasks-unchanged'); report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  server?.closeStreams(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
  await workbench.close(); await access.close();
  if (report.passed && projectDir && projectDir !== mobileRoot && isWithin(mobileRoot, projectDir)) {
    // Only remove this test's known artifact and then its empty directory; never recurse over user files.
    try {
      await unlink(path.join(projectDir, 'storage-check.txt'));
      // Windows may hold the child's working directory briefly after process termination.
      for (let attempt = 0; ; attempt++) {
        try { await rmdir(projectDir); break; }
        catch (error) { if (error.code !== 'EBUSY' || attempt >= 4) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
      }
      report.testDirectoryRemoved = true;
    }
    catch (error) { report.cleanupError = error.message; }
  }
  await writeFile('.runtime/storage-live-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
