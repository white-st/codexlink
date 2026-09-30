// Loopback-only Android recovery fixture. Synthetic accounts and Codex responses only.
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Workbench } from '../src/workbench.mjs';
import { CodexSessions } from '../src/codex-sessions.mjs';
import { AccessStore } from '../src/access-store.mjs';
import { Portal } from '../src/portal.mjs';
import { createHttpServer } from '../src/server.mjs';

await mkdir('.runtime/tests', { recursive: true });
const root = await mkdtemp(path.resolve('.runtime/tests/sync-ui-'));
const histories = new Map(), events = [];
let next = 0, mode = 'online', sends = 0;
class FixtureClient extends EventEmitter {
  async start() { this.ready = true; }
  async request(method, params) {
    if (method === 'account/read') return { account: {} };
    if (method === 'model/list') return { data: [] };
    if (method === 'thread/start') {
      const id = 'sync-ui-' + ++next;
      histories.set(id, Array.from({ length: 12 }, (_, i) => ({ id: 'old-' + i, status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'text', text: `第 ${i + 1} 条历史需求` }] },
        { type: 'agentMessage', text: `历史回复 ${i + 1}\n这是用于检查阅读位置和网络恢复的测试内容。\n返回任务时，应保留之前的阅读位置。` },
      ] })));
      return { thread: { id } };
    }
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: 'idle' }, turns: histories.get(params.threadId) || [] } };
    if (method === 'turn/start') {
      sends++;
      const turn = { id: 'new-' + ++next, status: 'completed', items: [
        { type: 'userMessage', content: params.input.filter(item => item.type === 'text') },
        { type: 'agentMessage', text: '发送已收到一次，网络恢复不会自动重复提交。' },
      ] };
      histories.set(params.threadId, [...histories.get(params.threadId), turn]);
      this.emit('message', { method: 'turn/completed', params: { threadId: params.threadId, turn } });
      return { turn };
    }
    return {};
  }
  async closeAndWait() { this.ready = false; }
  respond() {} rejectRequest() {}
}
const workbench = new Workbench({ root, client: new CodexSessions({ factory: () => new FixtureClient() }) });
await workbench.start();
const access = new AccessStore(root); await access.start();
const owner = await access.setup({ code: access.setupCode, username: 'sync_fixture', password: 'fixture-only-071' });
const portal = new Portal(workbench, access);
const project = await portal.createProject(owner.user.id, { name: '同步体验', level: 0 });
await portal.createTask(owner.user.id, { name: '文档整理', projectId: project.id });
await portal.createTask(owner.user.id, { name: '另一项工作', projectId: project.id });
const server = createHttpServer(workbench, access);
const handler = server.listeners('request')[0]; server.removeAllListeners('request');
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
server.on('request', (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__test/control') {
    mode = url.searchParams.get('mode') || mode;
    if (url.searchParams.has('append')) for (const history of histories.values()) history.push({ id: 'push-' + ++next, status: 'completed', items: [{ type: 'agentMessage', text: '网络恢复后新增的回复 ' + next }] });
    return json(res, 200, { mode, sends });
  }
  if (url.pathname === '/__test/state') return json(res, 200, { mode, sends, events });
  if (url.pathname === '/__test/stop' && req.method === 'POST') {
    json(res, 200, { sends });
    setTimeout(async () => { server.closeStreams();server.closeAllConnections();server.close();await workbench.close();await access.close();await writeFile('.runtime/sync-ui.json', JSON.stringify({ root, mode, sends, events }, null, 2)); }, 100);
    return;
  }
  events.push({ at: Date.now(), method: req.method, path: url.pathname, mode });
  if (mode === 'offline') return json(res, 503, { error: '模拟断线' });
  if (mode === 'verification' || mode === 'verification401') { res.writeHead(mode === 'verification401' ? 401 : 200, { 'Content-Type': 'text/html' });res.end('<html>verification fixture</html>');return; }
  if (mode === 'expired') return json(res, 401, { error: '模拟登录过期' });
  if (mode === 'revoked' && url.pathname === '/api/status') return json(res, 200, { ...portal.status(owner.user.id), projects: [], tasks: [], questions: [] });
  if (mode === 'partial' && url.pathname === '/api/status') { const status = portal.status(owner.user.id);return json(res, 200, { ...status, tasks: status.tasks.filter(t => t.name === '文档整理') }); }
  if (mode === 'partial' && url.pathname.startsWith('/api/history/')) return json(res, 503, { error: '模拟历史暂不可读' });
  req.headers.cookie = 'codex_link_session=' + owner.token;
  if (mode === 'slow' && (url.pathname === '/api/status' || url.pathname.startsWith('/api/history/'))) return setTimeout(() => handler(req, res), 6000);
  if (mode === 'slow-send' && url.pathname.endsWith('/send')) return setTimeout(() => handler(req, res), 6000);
  if (mode === 'lost-ack' && url.pathname.endsWith('/send')) {
    const end = res.end.bind(res);
    res.end = function () { res.destroy();return res; }; // Backend executes, but handset never receives acknowledgement.
    res.on('close', () => { res.end = end; });
  }
  handler(req, res);
});
server.listen(47816, '127.0.0.1', () => console.log('Synthetic sync UI server ready on 127.0.0.1:47816'));
