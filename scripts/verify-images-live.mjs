import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { AccessStore } from '../src/access-store.mjs';
import { Workbench } from '../src/workbench.mjs';
import { createHttpServer } from '../src/server.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const original = Object.fromEntries(await Promise.all(['access.json','registry.json'].map(async name => [name, sha(await readFile('.runtime/' + name))])));
await mkdir('.runtime/tests', { recursive: true });
const root = await mkdtemp(path.resolve('.runtime/tests/images-live-'));
const access = new AccessStore(root), workbench = new Workbench({ root });
const report = { checkedAt: new Date().toISOString(), fixture: root, checks: [], passed: false };
let server;
try {
  await access.start();await workbench.start();
  server = createHttpServer(workbench, access);await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = await access.setup({ code: access.setupCode, username: 'image_test', password: randomBytes(20).toString('hex') });
  const headers = { Cookie: 'codex_link_session=' + owner.token, 'X-Local-Client': '1', 'Content-Type': 'application/json' };
  const call = async (route, input) => {
    const res = await fetch(origin + '/api' + route, { method: input === undefined ? 'GET' : 'POST', headers, body: input === undefined ? undefined : JSON.stringify(input) });
    assert.ok(res.ok, `${route}: ${res.status} ${res.ok ? '' : await res.text()}`);return res;
  };
  const project = await (await call('/projects', { name: '图片识别独立验收', level: 0 })).json();
  const task = await (await call('/tasks', { name: '查看三种图片格式', projectId: project.id })).json();report.taskId = task.id;
  const attachments = [];
  for (const ext of ['jpg', 'png', 'webp']) {
    const bytes = await readFile(`test/fixtures/attachments/vision-fixture.${ext}`);
    const res = await fetch(origin + `/api/tasks/${task.id}/attachments?name=sample.${ext}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes });
    assert.equal(res.status, 201);const file = await res.json();attachments.push(file.name);
    const downloaded = Buffer.from(await (await call(`/tasks/${task.id}/file?name=${encodeURIComponent(file.name)}`)).arrayBuffer());
    assert.equal(sha(downloaded), sha(bytes));report.checks.push('original-bytes-' + ext);
  }
  await call(`/tasks/${task.id}/send`, { attachments, prompt: '这是已授权的图片输入验收。请直接观察本轮附上的三张图片，只回复图中从左到右的形状和颜色，以及图片下方的完整英文数字文字。不要调用工具或委派任务，不要根据文件名猜测，不要修改文件。若看不到图片请明确说明。' });
  const deadline = Date.now() + 240_000;
  while (workbench.tasks.get(task.id).busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
  const status = workbench.tasks.get(task.id);assert.equal(status.status, 'completed', status.error || 'Image turn did not complete');
  const history = await (await call(`/history/${task.id}`)).json();
  const items = history.turns.flatMap(turn => turn.items);
  const reply = items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
  assert.match(reply, /IMAGE[-－— ]?4729/);assert.match(reply, /红|red/i);assert.match(reply, /蓝|blue/i);assert.match(reply, /绿|green/i);
  assert.match(reply, /方|square/i);assert.match(reply, /圆|circle/i);assert.match(reply, /三角|triangle/i);
  const user = items.find(item => item.type === 'userMessage');
  assert.equal(user.content.filter(item => item.type === 'localImage' || item.type === 'image').length, 3);
  report.reply = reply;report.checks.push('real-Codex-three-image-inputs-and-visual-recognition');
  for (const [name, hash] of Object.entries(original)) assert.equal(sha(await readFile('.runtime/' + name)), hash);
  report.formalDataUnchanged = true;report.passed = true;
} catch (error) { report.error = error.message;process.exitCode = 1; }
finally {
  await writeFile('.runtime/images-live-verification.json', JSON.stringify(report, null, 2));console.log(JSON.stringify(report, null, 2));
  server?.closeStreams();server?.closeAllConnections();if (server) await new Promise(resolve => server.close(resolve));
  await workbench.close();await access.close();
}
