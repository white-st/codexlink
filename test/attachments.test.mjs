import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, open } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { AccessStore } from '../src/access-store.mjs';
import { Workbench } from '../src/workbench.mjs';
import { Portal } from '../src/portal.mjs';
import { createHttpServer } from '../src/server.mjs';
import { validateOffice, MAX_ATTACHMENT_BYTES, saveAttachment } from '../src/attachments.mjs';

const docx = await readFile('test/fixtures/attachments/中文说明.docx');
const pptx = await readFile('test/fixtures/attachments/演示文稿.pptx');
const pictures = await Promise.all(['jpg', 'png', 'webp'].map(async ext => [ext, await readFile(`test/fixtures/attachments/vision-fixture.${ext}`)]));
async function fixture(t) {
  await mkdir('.runtime/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.runtime/tests/attachments-'));
  const access = new AccessStore(root); await access.start();
  const client = new EventEmitter(); let next = 0; const calls = [];
  client.close = () => {}; client.respond = () => {};
  client.request = async (method, params) => { calls.push({ method, params }); return method === 'thread/start' ? { thread: { id: 'attachment-' + ++next } } : method === 'turn/start' ? { turn: { id: 'fixture-turn' } } : {}; };
  const workbench = new Workbench({ root, client }); workbench.connected = true; workbench.signedIn = true;
  const owner = await access.setup({ code: access.setupCode, username: 'owner', password: '628415' });
  const other = await access.createUser(owner.user.id, { username: 'other', password: '628415', level: 1 });
  const viewer = await access.login({ username: 'other', password: '628415' });
  const portal = new Portal(workbench, access);
  const project = await portal.createProject(owner.user.id, { name: '附件项目', level: 2 });
  const task = await portal.createTask(owner.user.id, { projectId: project.id, name: '处理附件' });
  const cwd = access.data.projects.find(p => p.id === project.id).cwd;
  const server = createHttpServer(workbench, access); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); await workbench.close(); await access.close(); });
  const call = (route, input, token = owner.token) => fetch(origin + '/api' + route, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: 'codex_link_session=' + token, 'X-Local-Client': '1', 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
  const upload = (name, data = docx, token = owner.token, headers = {}) => fetch(origin + `/api/tasks/${task.id}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Cookie: 'codex_link_session=' + token, 'X-Local-Client': '1', 'Content-Type': 'application/octet-stream', ...headers }, body: data });
  return { root, access, portal, workbench, calls, owner, other, viewer, project, task, cwd, server, origin, call, upload };
}

test('三种图片原字节上传下载，只有图片也发送为真实 localImage 输入', async t => {
  const f = await fixture(t), uploaded = [];
  for (const [ext, bytes] of pictures) {
    const res = await f.upload(`中文图片.${ext}`, bytes);assert.equal(res.status, 201);
    const file = await res.json();uploaded.push(file.name);
    const download = await f.call(`/tasks/${f.task.id}/file?name=${encodeURIComponent(file.name)}`);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  }
  assert.equal((await f.call(`/tasks/${f.task.id}/send`, { prompt: '', attachments: uploaded })).status, 200);
  const input = f.calls.find(c => c.method === 'turn/start').params.input;
  assert.equal(input[0].type, 'text');assert.match(input[0].text, /中文图片/);
  assert.deepEqual(input.slice(1), uploaded.map(name => ({ type: 'localImage', path: path.join(f.cwd, name) })));
});

test('图片格式伪装、缺末尾与损坏容器拒绝；发送前重新验证，任意图片路径不能注入', async t => {
  const f = await fixture(t);
  for (const [ext, bytes] of pictures) {
    for (const fake of [Buffer.from('not an image'), bytes.subarray(0, bytes.length - 4)]) assert.equal((await f.upload(`bad.${ext}`, fake)).status, 415);
  }
  assert.equal((await f.upload('wrong.png', pictures[0][1])).status, 415);
  assert.equal((await f.upload('wrong.docx', pictures[1][1])).status, 415);
  for (const name of ['image.svg', 'image.gif', 'image.heic', '../image.jpg']) assert.equal((await f.upload(name, pictures[0][1])).status, 400);
  const uploaded = await (await f.upload('photo.jpeg', pictures[0][1])).json();
  await writeFile(path.join(f.cwd, uploaded.name), 'changed after uploading');
  assert.equal((await f.call(`/tasks/${f.task.id}/send`, { prompt: '看图', attachments: [uploaded.name] })).status, 415);
  assert.equal((await f.call(`/tasks/${f.task.id}/send`, { prompt: '看图', images: [{ type: 'localImage', path: 'C:/private.jpg' }] })).status, 400);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 0);
});

test('图片继承私有、等级共享、撤销和跨项目引用规则，文档图片混合不丢输入', async t => {
  const f = await fixture(t), png = pictures[1][1];
  assert.equal((await f.upload('a.png', png, '')).status, 401);
  assert.equal((await f.upload('a.png', png, f.viewer.token)).status, 404);
  const file = await (await f.upload('a.png', png)).json();
  await f.portal.updateProject(f.owner.user.id, f.project.id, { shared: true });
  const route = `/tasks/${f.task.id}/file?name=${encodeURIComponent(file.name)}`;
  assert.equal((await f.call(route, undefined, f.viewer.token)).status, 404);
  await f.portal.updateProject(f.owner.user.id, f.project.id, { level: 1 });
  assert.equal((await f.call(route, undefined, f.viewer.token)).status, 200);
  assert.equal((await f.upload('a.png', png, f.viewer.token)).status, 403);
  assert.equal((await f.call(`/tasks/${f.task.id}/send`, { prompt: '看图', attachments: [file.name] }, f.viewer.token)).status, 403);
  await f.portal.updateProject(f.owner.user.id, f.project.id, { shared: false });
  assert.equal((await f.call(route, undefined, f.viewer.token)).status, 404);
  const second = await f.portal.createProject(f.owner.user.id, { name: '另一个图片项目' });
  const secondTask = await f.portal.createTask(f.owner.user.id, { projectId: second.id, name: '拒绝跨项目' });
  assert.equal((await f.call(`/tasks/${secondTask.id}/send`, { prompt: '看图', attachments: [file.name] })).status, 404);
  const doc = await (await f.upload('word.docx')).json();
  assert.equal((await f.call(`/tasks/${f.task.id}/send`, { prompt: '综合处理', attachments: [file.name, doc.name] })).status, 200);
  const input = f.calls.find(c => c.method === 'turn/start').params.input;
  assert.equal(input.length, 2);assert.match(input[0].text, /word.docx/);assert.equal(input[1].type, 'localImage');
});
test('Word/PPT 上传落盘字节一致、同名不覆盖，引用进入实际 Codex 需求，附件可单独发送', async t => {
  const f = await fixture(t); const uploaded = [];
  for (const [name, bytes] of [['中文说明.docx', docx], ['演示文稿.pptx', pptx], ['中文说明.docx', docx]]) {
    const res = await f.upload(name, bytes); assert.equal(res.status, 201); const file = await res.json(); uploaded.push(file.name);
    assert.equal(file.originalName, name); assert.equal(file.size, bytes.length); assert.ok(!JSON.stringify(file).includes(f.cwd));
    assert.deepEqual(await readFile(path.join(f.cwd, file.name)), bytes);
    assert.deepEqual(Buffer.from(await (await f.call(`/tasks/${f.task.id}/file?name=${encodeURIComponent(file.name)}`)).arrayBuffer()), bytes);
  }
  assert.equal(new Set(uploaded).size, 3);
  const sent = await f.call(`/tasks/${f.task.id}/send`, { prompt: '', attachments: uploaded }); assert.equal(sent.status, 200);
  const params = f.calls.find(c => c.method === 'turn/start').params;
  for (const name of uploaded) assert.ok(params.input[0].text.includes(name));
  assert.ok(params.input[0].text.includes('请阅读附件')); assert.equal(params.cwd, f.cwd);
  assert.equal(f.access.data.revision, 4, 'file upload adds no access schema or revision writes');
});
test('匿名、私有猜测、等级不足与共享只读拒绝上传及引用，撤销共享立即禁止下载', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload('a.docx', docx, '')).status, 401);
  assert.equal((await f.upload('a.docx', docx, f.viewer.token)).status, 404);
  const file = await (await f.upload('a.docx')).json();
  await f.portal.updateProject(f.owner.user.id, f.project.id, { shared: true });
  assert.equal((await f.upload('a.docx', docx, f.viewer.token)).status, 404);
  await f.portal.updateProject(f.owner.user.id, f.project.id, { level: 1 });
  assert.equal((await f.upload('a.docx', docx, f.viewer.token)).status, 403);
  assert.equal((await f.call(`/tasks/${f.task.id}/send`, { prompt: 'read', attachments: [file.name] }, f.viewer.token)).status, 403);
  assert.equal((await f.call(`/tasks/${f.task.id}/file?name=${encodeURIComponent(file.name)}`, undefined, f.viewer.token)).status, 200);
  await f.portal.updateProject(f.owner.user.id, f.project.id, { shared: false });
  assert.equal((await f.call(`/tasks/${f.task.id}/file?name=${encodeURIComponent(file.name)}`, undefined, f.viewer.token)).status, 404);
  const second = await f.portal.createProject(f.owner.user.id, { name: '另一个项目' });
  const secondTask = await f.portal.createTask(f.owner.user.id, { name: '另一个任务', projectId: second.id });
  assert.equal((await f.call(`/tasks/${secondTask.id}/send`, { prompt: 'read', attachments: [file.name] })).status, 404);
});
test('来源、格式、大小和路径边界拒绝；伪造引用不能启动执行', async t => {
  const f = await fixture(t);
  for (const name of ['../a.docx','C:\\a.docx','a.doc','a.ppt','a.docx.exe','CON.docx','bad\n.docx']) assert.equal((await f.upload(name)).status, 400, name);
  assert.equal((await f.upload('a.docx', Buffer.from('fake'))).status, 415);
  assert.equal((await f.upload('a.docx', pptx)).status, 415);
  assert.equal((await f.upload('a.docx', Buffer.alloc(0))).status, 400);
  assert.equal((await f.upload('a.docx', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).status, 413);
  assert.equal((await f.upload('a.docx', docx, f.owner.token, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.upload('a.docx', docx, f.owner.token, { 'X-Local-Client': '' })).status, 403);
  for (const attachments of [['../private.docx'], ['x','x'], [1], 'not-an-array', ['a','b','c','d']]) assert.equal((await f.call(`/tasks/${f.task.id}/send`, { prompt: 'test', attachments })).status, 400);
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  assert.equal((await readdir(f.cwd)).length, 0);
});
test('读请求途中注销、排队期间删除均不能写入项目；失败不留下临时文件', async t => {
  const f = await fixture(t);
  const received = new Promise((resolve, reject) => {
    const req = http.request(f.origin + `/api/tasks/${f.task.id}/attachments?name=a.docx`, { method: 'POST', headers: { Cookie: 'codex_link_session=' + f.owner.token, 'X-Local-Client': '1', 'Content-Type': 'application/octet-stream' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(docx.subarray(0, 20));
    setTimeout(() => { f.access.logout(f.owner.token); req.end(docx.subarray(20)); }, 30);
  });
  assert.equal(await received, 401); assert.equal((await readdir(f.cwd)).length, 0);
  const removal = f.portal.removeProject(f.owner.user.id, f.project.id, { confirmName: '附件项目' });
  const pending = f.portal.upload(f.owner.user.id, f.task.id, 'a.docx', docx);
  await removal; await assert.rejects(pending, e => e.statusCode === 404);
  for (const revokeAt of [2, 3]) {
    let checked = 0;
    await assert.rejects(saveAttachment(f.cwd, 'a.docx', docx, () => { if (++checked === revokeAt) throw Error('revoked'); }), /revoked/);
    assert.deepEqual(await readdir(path.join(f.cwd, 'attachments')), []);
  }
});
test('文件目录链接不能越过项目；临时文件不可列出或下载', async t => {
  const f = await fixture(t); const outside = path.join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(f.cwd, 'attachments'), 'junction');
  assert.equal((await f.upload('a.docx')).status, 409); assert.deepEqual(await readdir(outside), []);
  await writeFile(path.join(f.cwd, '.upload-part'), 'partial');
  assert.deepEqual(await f.portal.files(f.owner.user.id, f.task.id), []);
  await assert.rejects(f.portal.file(f.owner.user.id, f.task.id, '.upload-part'));
});
test('损坏 ZIP 目录和不支持的压缩包不会被当作 Office 附件', () => {
  validateOffice('a.docx', docx); validateOffice('a.pptx', pptx);
  for (const bytes of [docx.subarray(0, docx.length - 1), Buffer.concat([docx, Buffer.from('junk')])]) assert.throws(() => validateOffice('a.docx', bytes), e => e.statusCode === 415);
  const corrupt = Buffer.from(docx); corrupt.writeUInt32LE(0xfffffffe, corrupt.length - 6); assert.throws(() => validateOffice('a.docx', corrupt), e => e.statusCode === 415);
  const expanded = Buffer.from(docx), directory = expanded.readUInt32LE(expanded.length - 6);
  expanded.writeUInt32LE(500 * 1024 * 1024 + 1, directory + 24); assert.throws(() => validateOffice('a.docx', expanded), e => e.statusCode === 415);
});

test('100 MB 上限一致：超限下载与未知长度超限上传拒绝，上传失败不落盘', async t => {
  const f = await fixture(t);
  assert.equal(MAX_ATTACHMENT_BYTES, 100 * 1024 * 1024);
  const file = await open(path.join(f.cwd, 'oversized.pptx'), 'w');
  try { await file.truncate(MAX_ATTACHMENT_BYTES + 1); } finally { await file.close(); }
  assert.equal((await f.call(`/tasks/${f.task.id}/file?name=oversized.pptx`)).status, 413);
  const response = await new Promise((resolve, reject) => {
    const req = http.request(f.origin + `/api/tasks/${f.task.id}/attachments?name=a.pptx`, { method: 'POST', headers: { Cookie: 'codex_link_session=' + f.owner.token, 'X-Local-Client': '1', 'Content-Type': 'application/octet-stream' } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    const block = Buffer.alloc(64 * 1024); let sent = 0;
    function send() {
      while (sent < MAX_ATTACHMENT_BYTES + 1) {
        const next = block.subarray(0, Math.min(block.length, MAX_ATTACHMENT_BYTES + 1 - sent)); sent += next.length;
        if (!req.write(next)) { req.once('drain', send); return; }
      }
      req.end();
    }
    send();
  });
  assert.equal(response.status, 413); assert.match(response.body, /100 MB/);
  assert.deepEqual(await readdir(f.cwd), ['oversized.pptx']);
});
