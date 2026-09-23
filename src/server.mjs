import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Workbench } from './workbench.mjs';
import { AccessStore, failure, publicUser } from './access-store.mjs';
import { Portal, execution } from './portal.mjs';
import { acquireLock } from './runtime-lock.mjs';
import { requestContext, validateNetwork, lanAddresses } from './network.mjs';
import { QuickTunnel } from './quick-tunnel.mjs';
import { attachmentName, MAX_ATTACHMENT_BYTES } from './attachments.mjs';
import { FILE_LIMIT_LABEL } from './file-limits.mjs';
import { isApkPath } from './releases.mjs';

const base = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/android', ['android.html', 'text/html; charset=utf-8']],
  ['/android.css', ['android.css', 'text/css; charset=utf-8']],
  ['/android.js', ['android.js', 'text/javascript; charset=utf-8']],
  ['/downloads/release.json', ['downloads/release.json', 'application/json; charset=utf-8']],
]);
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw failure('请求过大', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw failure('请求格式无效'); }
}
function cookie(req) {
  return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('codex_link_session='))?.slice('codex_link_session='.length) || '';
}
function setSession(res, token, secure = false) {
  res.setHeader('Set-Cookie', `codex_link_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 28800 : 0}${secure ? '; Secure' : ''}`);
}
function secretMatches(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function createHttpServer(workbench, access, { controlToken, network = {}, connections = () => ({}) } = {}) {
  if (!access) throw new Error('HTTP 服务必须提供身份与项目权限存储');
  const portal = new Portal(workbench, access);
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const token = cookie(req); let protectedResponse = false;
    const json = (status, value) => {
      if (protectedResponse && status < 400) access.session(token);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
    };
    try {
      const context = requestContext(req, server.address().port, network);
      const url = new URL(req.url, context.origin);
      if (context.secure) res.setHeader('Strict-Transport-Security', 'max-age=86400');
      if (req.method === 'GET' && (publicFiles.has(url.pathname) || isApkPath(url.pathname))) {
        const [file, type] = publicFiles.get(url.pathname) || [url.pathname.slice(1), 'application/vnd.android.package-archive'];
        const content = await readFile(path.join(base, 'public', file)).catch(error => { if (error.code === 'ENOENT') throw failure('页面不存在', 404); throw error; });
        if (type === 'application/vnd.android.package-archive') res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
        res.writeHead(200, { 'Content-Type': type }); return res.end(content);
      }
      if (!url.pathname.startsWith('/api/')) return json(404, { error: '页面不存在' });
      let input;
      const upload = req.method === 'POST' && url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/attachments$/);
      if (upload) {
        if (req.headers['x-local-client'] !== '1' || req.headers['content-type'] !== 'application/octet-stream') throw failure('附件上传来源或格式不被允许', 403);
        const user = access.session(token); protectedResponse = true; portal.executable(user.id, upload[1]);
        if ([...url.searchParams.keys()].some(key => key !== 'name') || url.searchParams.getAll('name').length !== 1) throw failure('附件参数无效');
        const filename = attachmentName(url.searchParams.get('name'));
        if (Number(req.headers['content-length']) > MAX_ATTACHMENT_BYTES) throw failure(`单个附件不能超过 ${FILE_LIMIT_LABEL}`, 413);
        const finishUpload = portal.beginUpload(user.id, upload[1], () => access.session(token));
        try {
          const chunks = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_ATTACHMENT_BYTES) throw failure(`单个附件不能超过 ${FILE_LIMIT_LABEL}`, 413);
            chunks.push(chunk);
          }
          return json(201, await portal.upload(user.id, upload[1], filename, Buffer.concat(chunks), () => access.session(token)));
        } finally { finishUpload(); }
      }
      if (req.method === 'POST') {
        if (req.headers['x-local-client'] !== '1' || req.headers['content-type']?.split(';')[0] !== 'application/json') throw failure('请求来源或格式不被允许', 403);
        input = await body(req);
      }
      if (req.method === 'GET' && url.pathname === '/api/auth') {
        let user = null;
        try { user = publicUser(access.session(token)); } catch {}
        return json(200, { setupRequired: access.data.users.length === 0, setupAllowed: context.localManagement, user, execution,
          connection: { kind: context.kind, updates: context.updates, ...(context.localManagement ? connections() : {}) } });
      }
      if (req.method === 'POST' && ['/api/auth/setup', '/api/auth/login'].includes(url.pathname)) {
        if (url.pathname.endsWith('/setup') && !context.localManagement) throw failure('首次管理员设置请在电脑本机完成', 403);
        const now = Date.now();
        if (!server.loginWindow || server.loginWindow.until < now) server.loginWindow = { count: 0, until: now + 60_000 };
        if (++server.loginWindow.count > 60) throw failure('登录请求过于频繁，请稍后重试', 429);
        const result = url.pathname.endsWith('/setup') ? await access.setup(input, [...workbench.tasks.values()]) : await access.login(input);
        if (token) access.logout(token);
        setSession(res, result.token, context.secure); return json(200, { user: result.user });
      }
      if (req.method === 'POST' && url.pathname === '/api/server/stop') {
        if (!context.localManagement || !secretMatches(req.headers['x-control-token'], controlToken)) throw failure('仅可通过本机停止工具操作', 403);
        json(200, { stopping: true }); setImmediate(() => server.emit('shutdown')); return;
      }
      const user = access.session(token); protectedResponse = true;
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        access.logout(token); setSession(res, '', context.secure); protectedResponse = false; return json(200, { loggedOut: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/password') {
        await access.changePassword(user.id, input); setSession(res, '', context.secure); protectedResponse = false; return json(200, { changed: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return json(200, portal.status(user.id));
      if (req.method === 'GET' && url.pathname === '/api/projects') return json(200, portal.projects(user.id, url.searchParams.get('source'), url.searchParams.get('q') || ''));
      if (req.method === 'GET' && url.pathname === '/api/desktop') return json(200, { data: portal.tasks(user.id, 'desktop'), nextCursor: null });
      if (req.method === 'GET' && url.pathname === '/api/admin/users') return json(200, access.users(user.id));
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (context.updates !== 'events') throw failure('此连接使用定时刷新获取进度', 409);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }); res.write(': connected\n\n');
        const send = (value, eventName) => {
          if (res.writableEnded || res.destroyed) return;
          if (res.writableLength > 1024 * 1024) { res.end(); return; }
          res.write(`${eventName ? 'event: ' + eventName + '\n' : ''}data: ${JSON.stringify(value)}\n\n`);
        };
        const update = event => {
          try { access.session(token); } catch { res.end(); return; }
          const output = portal.event(user.id, event); if (output) send(output);
        };
        const invalidate = () => { send({ refresh: true }, 'access-changed'); res.end(); };
        const changed = () => send({ type: 'refresh' });
        workbench.on('event', update); access.on('permissions', invalidate); access.on('changed', changed); streams.add(res);
        const heartbeat = setInterval(() => {
          try { access.session(token); if (!res.writableEnded && !res.destroyed) res.write(': heartbeat\n\n'); }
          catch { invalidate(); }
        }, 15_000);
        res.on('close', () => {
          clearInterval(heartbeat); workbench.off('event', update); access.off('permissions', invalidate); access.off('changed', changed); streams.delete(res);
        });
        return;
      }
      const history = url.pathname.match(/^\/api\/history\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && history) return json(200, await portal.history(user.id, history[1]));
      const task = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/(send|stop|reconcile|answer|files|file|transfer|skills)$/);
      if (req.method === 'GET' && task?.[2] === 'skills') return json(200, await portal.skills(user.id, task[1], () => access.session(token)));
      if (req.method === 'GET' && task?.[2] === 'files') return json(200, await portal.files(user.id, task[1]));
      if (req.method === 'GET' && task?.[2] === 'file') {
        const filename = url.searchParams.get('name'); const content = await portal.file(user.id, task[1], filename);
        access.session(token);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filename))}` });
        return res.end(content);
      }
      if (req.method === 'POST') {
        if (url.pathname === '/api/projects') return json(201, await portal.createProject(user.id, input));
        if (url.pathname === '/api/tasks') return json(201, await portal.createTask(user.id, input, () => access.session(token)));
        if (url.pathname === '/api/admin/users') return json(201, await access.createUser(user.id, input));
        const passwordAction = url.pathname.match(/^\/api\/admin\/users\/([a-zA-Z0-9_-]+)\/password\/(view|reset)$/);
        if (passwordAction?.[2] === 'view') return json(200, access.viewPassword(user.id, passwordAction[1], input));
        if (passwordAction?.[2] === 'reset') return json(200, await access.resetPassword(user.id, passwordAction[1], input, () => access.session(token)));
        const project = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)$/);
        if (project) return json(200, await portal.updateProject(user.id, project[1], input));
        const removal = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/remove$/);
        if (removal) return json(200, await portal.removeProject(user.id, removal[1], input, () => access.session(token)));
        const member = url.pathname.match(/^\/api\/admin\/users\/([a-zA-Z0-9_-]+)$/);
        if (member) return json(200, await access.updateUser(user.id, member[1], input));
        if (task) {
          if (task[2] === 'transfer') return json(200, await portal.transfer(user.id, task[1], input, () => access.session(token)));
          if (task[2] === 'reconcile') {
            return json(200, await portal.reconcile(user.id, task[1]));
          }
          if (task[2] === 'send') return json(200, await portal.send(user.id, task[1], input, () => access.session(token)));
          if (task[2] === 'answer') return json(200, portal.answer(user.id, task[1], input));
          if (task[2] === 'stop') return json(200, await portal.stop(user.id, task[1]));
        }
      }
      return json(404, { error: '接口不存在' });
    } catch (error) {
      if (!res.headersSent) json(error.statusCode || 400, { error: error.statusCode ? error.message : '操作失败，请在本机检查服务状态' });
      else res.end();
    }
  });
  server.closeStreams = () => { for (const res of streams) res.end(); };
  return server;
}

async function main() {
  process.chdir(base);
  const root = process.env.CODEX_LINK_RUNTIME ? path.resolve(process.env.CODEX_LINK_RUNTIME) : path.join(base, '.runtime');
  await mkdir(root, { recursive: true });
  const releaseLock = await acquireLock(path.join(root, 'server.lock'));
  const workbench = new Workbench({ root }); const access = new AccessStore(root);
  let server, proxyServer, tunnel; let stopping; let metadataQueue = Promise.resolve();
  function stop() {
    if (!stopping) stopping = (async () => {
      await tunnel?.close(); await metadataQueue.catch(() => {});
      for (const current of [server, proxyServer]) { current?.closeStreams(); current?.close(); }
      await workbench.close(); await access.close(); await releaseLock();
    })();
    return stopping;
  }
  try {
    await access.start(); await workbench.start();
    let config = { lanAddresses: [], quickTunnel: false };
    try { config = validateNetwork(JSON.parse(await readFile(path.join(root, 'network.json'), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const currentAddresses = lanAddresses();
    if (config.lanAddresses.some(address => !currentAddresses.includes(address))) throw new Error('配置的 Wi-Fi 地址已变化，请重新配置手机连接');
    const controlToken = randomBytes(32).toString('base64url');
    const info = { pid: process.pid, controlToken, lanUrls: [], publicUrl: null, remoteStatus: config.quickTunnel ? 'starting' : 'disabled',
      remoteProvider: config.ddnsto ? 'ddnsto' : config.quickTunnel ? 'cloudflare' : null, proxyTarget: null };
    const connections = () => ({ lanUrls: info.lanUrls, publicUrl: info.publicUrl, remoteStatus: info.remoteStatus,
      remoteProvider: info.remoteProvider, proxyTarget: info.proxyTarget });
    server = createHttpServer(workbench, access, { controlToken, network: config, connections }); server.once('shutdown', () => void stop());
    const port = process.env.PORT === undefined ? 4317 : Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 无效');
    if (config.ddnsto?.port === port) throw new Error('DDNSTO 转发端口必须与工作台本机端口不同');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, config.lanAddresses.length ? '0.0.0.0' : '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}`;
    info.url = url; info.lanUrls = config.lanAddresses.map(address => `http://${address}:${server.address().port}`);
    const saveInfo = () => {
      const data = JSON.stringify(info, null, 2);
      metadataQueue = metadataQueue.catch(() => {}).then(() => writeFile(path.join(root, 'server.json'), data, { mode: 0o600 }));
      return metadataQueue;
    };
    await saveInfo();
    if (config.ddnsto) {
      proxyServer = createHttpServer(workbench, access, { network: { proxy: true, proxyProvider: 'ddnsto', publicOrigin: config.ddnsto.origin } });
      await new Promise((resolve, reject) => { proxyServer.once('error', reject); proxyServer.listen(config.ddnsto.port, '127.0.0.1', resolve); });
      info.publicUrl = config.ddnsto.origin; info.proxyTarget = `http://127.0.0.1:${config.ddnsto.port}`;
      info.remoteStatus = config.ddnsto.origin ? 'configured' : 'awaiting-address';
      await saveInfo();
    }
    if (config.quickTunnel) {
      const proxyNetwork = { proxy: true, publicOrigin: null };
      proxyServer = createHttpServer(workbench, access, { network: proxyNetwork });
      await new Promise((resolve, reject) => { proxyServer.once('error', reject); proxyServer.listen(0, '127.0.0.1', resolve); });
      tunnel = new QuickTunnel({ executable: path.join(base, '.runtime', 'bin', 'cloudflared.exe'), root, port: proxyServer.address().port });
      tunnel.on('change', state => {
        if (stopping) return;
        proxyNetwork.publicOrigin = state.url; info.publicUrl = state.url; info.remoteStatus = state.status;
        void saveInfo().catch(() => console.error('保存连接地址失败，请检查本机状态文件。'));
      });
      await tunnel.start();
    }
    console.log(`Codex Link 已启动：${url}`);
    if (!access.data.users.length) console.log(`首次管理员设置码位于：${path.join(root, 'setup-code.txt')}`);
    for (const address of info.lanUrls) console.log(`同 Wi-Fi 手机地址：${address}`);
    console.log('账号权限版本：所有者可执行手机任务，共享项目按等级只读。连接地址保存在本机状态文件。');
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  } catch (error) { await stop(); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
