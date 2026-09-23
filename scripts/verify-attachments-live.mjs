import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { AccessStore } from '../src/access-store.mjs';
import { Workbench } from '../src/workbench.mjs';
import { createHttpServer } from '../src/server.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const original = Object.fromEntries(await Promise.all(['access.json','registry.json'].map(async name => [name, sha(await readFile('.runtime/' + name))])));
await mkdir('.runtime/tests', { recursive: true });
const root = await mkdtemp(path.resolve('.runtime/tests/attachment-live-'));
const access = new AccessStore(root), workbench = new Workbench({ root });
const report = { checkedAt: new Date().toISOString(), fixture: root, checks: [], passed: false };
let server, origin;
try {
  await access.start(); await workbench.start();
  server = createHttpServer(workbench, access); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const owner = await access.setup({ code: access.setupCode, username: 'attachment_test', password: randomBytes(20).toString('hex') });
  const headers = { Cookie: 'codex_link_session=' + owner.token, 'X-Local-Client': '1', 'Content-Type': 'application/json' };
  const call = async (route, input) => {
    const res = await fetch(origin + '/api' + route, { method: input === undefined ? 'GET' : 'POST', headers, body: input === undefined ? undefined : JSON.stringify(input) });
    assert.ok(res.ok, `${route}: ${res.status} ${await (res.ok ? Promise.resolve('') : res.text())}`); return res;
  };
  const project = await (await call('/projects', { name: '附件真实读取验收', level: 0 })).json();
  const task = await (await call('/tasks', { name: '读取 Word 与 PPT', projectId: project.id })).json();report.taskId = task.id;
  const attachments = [];
  for (const name of ['中文说明.docx', '演示文稿.pptx']) {
    const bytes = await readFile('test/fixtures/attachments/' + name);
    const res = await fetch(origin + `/api/tasks/${task.id}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes });
    assert.equal(res.status, 201, await (res.status === 201 ? Promise.resolve('') : res.text()));
    const file = await res.json(); attachments.push(file.name);
    const downloaded = await (await call(`/tasks/${task.id}/file?name=${encodeURIComponent(file.name)}`)).arrayBuffer();
    assert.equal(sha(Buffer.from(downloaded)), sha(bytes));report.checks.push('upload-download-' + path.extname(name));
  }
  await call(`/tasks/${task.id}/send`, { attachments, prompt: '这是已授权的附件读取联调。请实际读取本轮 Word 和 PPT 附件，在当前项目写入 UTF-8 文件“附件读取结果.txt”：每行分别写出 Word 与 PPT 正文中以 WORD- 和 PPT- 开头的完整校验文字。不要猜测内容，不要改动附件，不访问其他项目，不委派任务。可使用本机 Python 的 zipfile 和 XML 工具读取 Office 文件。完成后简短回复。' });
  const deadline = Date.now() + 240_000;
  while (workbench.tasks.get(task.id).busy && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));
  const status = workbench.tasks.get(task.id); report.taskStatus = status.status;
  assert.equal(status.status, 'completed', status.error || 'Task did not complete');
  const text = await (await call(`/tasks/${task.id}/file?name=${encodeURIComponent('附件读取结果.txt')}`)).text();
  assert.match(text, /WORD-C049-紫竹-7318/);assert.match(text, /PPT-C049-青禾-9462/);
  report.checks.push('real-Codex-read-both-Office-documents-and-write-output');
  for (const [name, hash] of Object.entries(original)) assert.equal(sha(await readFile('.runtime/' + name)), hash);
  report.formalDataUnchanged = true;report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  await writeFile('.runtime/attachments-live-verification.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  server?.closeStreams();server?.closeAllConnections();if (server) await new Promise(r => server.close(r));
  await workbench.close();await access.close();
}
