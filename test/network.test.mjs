import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { AccessStore } from '../src/access-store.mjs';
import { createHttpServer } from '../src/server.mjs';
import { requestContext, validateNetwork, proxyHost, sameLanPeer, ddnstoOrigin } from '../src/network.mjs';
import { tunnelAddress, tunnelEnvironment } from '../src/quick-tunnel.mjs';

test('隧道错误中的服务商 API 地址不能显示成用户访问入口', () => {
  assert.equal(tunnelAddress('failed to request: Post "https://api.trycloudflare.com/tunnel": timeout'), null);
  assert.equal(tunnelAddress('INF | https://test-quick-tunnel.trycloudflare.com   |'), 'https://test-quick-tunnel.trycloudflare.com');
});

test('隧道沿用用户网络代理，但不继承 Codex 身份和主目录', () => {
  const env = tunnelEnvironment({ HTTP_PROXY: 'http://127.0.0.1:7897', OPENAI_API_KEY: 'fixture-secret', CODEX_HOME: 'private', USERPROFILE: 'private', PATH: 'bin' }, 'isolated');
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7897'); assert.equal(env.USERPROFILE, 'isolated');
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.CODEX_HOME, undefined);
});

const password = 'network-fixture-only-password';
const request = (server, route, { host, origin, token, input, headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api' + route,
    method: input === undefined ? 'GET' : 'POST', headers: { Host: host || `127.0.0.1:${server.address().port}`, ...(origin ? { Origin: origin } : {}),
      ...(token ? { Cookie: 'codex_link_session=' + token } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'X-Local-Client': '1' }), ...headers } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
      const text = Buffer.concat(chunks).toString(); let data;
      try { data = JSON.parse(text); } catch { data = text; }
      resolve({ status: res.statusCode, data, headers: res.headers });
    });
  });
  req.on('error', reject); req.end(input === undefined ? undefined : JSON.stringify(input));
});
async function fixture(t, setup = true) {
  await mkdir('.runtime/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.runtime/tests/network-')); const access = new AccessStore(root); await access.start();
  const workbench = new EventEmitter(); workbench.tasks = new Map(); workbench.questions = new Map();
  workbench.readThread = async () => ({ turns: [], status: { type: 'idle' } });
  const servers = [];
  t.after(async () => { for (const server of servers) { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await access.close(); });
  const create = async network => { const server = createHttpServer(workbench, access, { controlToken: 'fixture-stop-token', network }); servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server; };
  const main = await create({ lanAddresses: ['192.168.50.20'] });
  const proxy = await create({ proxy: true, publicOrigin: 'https://fixture.trycloudflare.com' });
  const owner = setup ? await access.setup({ code: access.setupCode, username: 'owner', password }) : null;
  return { root, access, main, proxy, owner, workbench, create };
}

test('DDNSTO 配置只接受 HTTPS 域名和独立端口，未填地址不虚构连接', () => {
  assert.equal(ddnstoOrigin('https://Workbench.ddnsto.com/'), 'https://workbench.ddnsto.com');
  assert.deepEqual(validateNetwork({ ddnsto: {} }).ddnsto, { origin: null, port: 4318 });
  for (const origin of ['http://workbench.ddnsto.com', 'https://user:secret@workbench.ddnsto.com', 'https://workbench.ddnsto.com/api',
    'https://workbench.ddnsto.com/?token=secret', 'https://workbench.ddnsto.com/#x', 'https://127.0.0.1', 'https://[::1]', 'https://*.ddnsto.com', 'https://x.localhost']) {
    assert.throws(() => validateNetwork({ ddnsto: { origin } }));
  }
  for (const ddnsto of [[], 'domain', { port: 0 }, { port: 65536 }, { port: '4318' }, { origin: false }, { token: 'not-accepted' }]) assert.throws(() => validateNetwork({ ddnsto }));
  assert.throws(() => validateNetwork({ quickTunnel: true, ddnsto: {} }));
});

test('DDNSTO 转发只承认配置地址和真实回环来源，转发头不能改变权限', () => {
  const network = { proxy: true, proxyProvider: 'ddnsto', publicOrigin: 'https://workbench.ddnsto.com' };
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:4318' } };
  for (const host of ['127.0.0.1:4318', 'workbench.ddnsto.com', 'workbench.ddnsto.com:443']) {
    const context = requestContext({ ...req, headers: { host, origin: network.publicOrigin, 'x-forwarded-host': '127.0.0.1:4317' } }, 4318, network);
    assert.equal(context.localManagement, false); assert.equal(context.secure, true); assert.equal(context.updates, 'poll');
  }
  assert.throws(() => requestContext({ ...req, socket: { remoteAddress: '192.168.10.10' } }, 4318, network));
  assert.throws(() => requestContext({ ...req, headers: { host: 'unrelated.ddnsto.com' } }, 4318, network));
  assert.throws(() => requestContext({ ...req, headers: { ...req.headers, origin: 'http://127.0.0.1:4318' } }, 4318, network));
});

test('DDNSTO 入口未填地址时拒绝请求，配置后仍不能初始化或停止', async t => {
  const f = await fixture(t, false);
  const network = { proxy: true, proxyProvider: 'ddnsto', publicOrigin: null };
  const proxy = await f.create(network);
  assert.equal((await request(proxy, '/auth')).status, 503);
  network.publicOrigin = 'https://workbench.ddnsto.com';
  for (const host of [`127.0.0.1:${proxy.address().port}`, 'workbench.ddnsto.com']) {
    const info = await request(proxy, '/auth', { host });
    assert.equal(info.data.setupAllowed, false); assert.equal(info.data.setupRequired, true); assert.equal(info.data.connection.kind, 'remote');
    assert.equal((await request(proxy, '/auth/setup', { host, origin: network.publicOrigin, input: { code: f.access.setupCode, username: 'owner', password } })).status, 403);
    assert.equal((await request(proxy, '/server/stop', { host, input: {}, headers: { 'X-Control-Token': 'fixture-stop-token' } })).status, 403);
  }
  assert.equal((await request(f.main, '/auth', { host: 'workbench.ddnsto.com' })).status, 403);
});

test('DDNSTO 登录带 Secure，拒绝跨站及匿名数据访问，注销后会话失效', async t => {
  const f = await fixture(t);
  const proxy = await f.create({ proxy: true, proxyProvider: 'ddnsto', publicOrigin: 'https://workbench.ddnsto.com' });
  const options = { host: 'workbench.ddnsto.com', origin: 'https://workbench.ddnsto.com' };
  assert.equal((await request(proxy, '/status', options)).status, 401);
  const login = await request(proxy, '/auth/login', { ...options, input: { username: 'owner', password } });
  assert.equal(login.status, 200); assert.match(login.headers['set-cookie'][0], /; Secure/);
  const token = login.headers['set-cookie'][0].match(/^codex_link_session=([^;]+)/)[1];
  assert.equal((await request(proxy, '/status', { ...options, token })).status, 200);
  assert.equal((await request(proxy, '/status', { ...options, token, origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await request(proxy, '/events', { ...options, token })).status, 409);
  assert.equal((await request(proxy, '/auth/logout', { ...options, token, input: {} })).status, 200);
  assert.equal((await request(f.main, '/status', { token })).status, 401);
});
test('网络配置拒绝公网、通配符和注入，只允许明确的局域网地址', () => {
  assert.deepEqual(validateNetwork({ lanAddresses: ['192.168.1.2'], quickTunnel: true }).lanAddresses, ['192.168.1.2']);
  for (const address of ['0.0.0.0', '8.8.8.8', '127.0.0.1', '192.168.1.2:4317', '*.local']) assert.throws(() => validateNetwork({ lanAddresses: [address] }));
  const interfaces = { test: [{ address: '192.168.50.20', netmask: '255.255.255.0' }] };
  assert.equal(sameLanPeer('192.168.50.5', ['192.168.50.20'], interfaces), true);
  assert.equal(sameLanPeer('192.168.51.5', ['192.168.50.20'], interfaces), false);
});
test('伪造 Host、Origin、转发头或代理连接地址不能获得本机管理身份', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:4317' } };
  assert.equal(requestContext(req, 4317).localManagement, true);
  assert.throws(() => requestContext({ ...req, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, 4317));
  assert.throws(() => requestContext({ ...req, socket: { remoteAddress: '192.168.10.9' } }, 4317));
  assert.throws(() => requestContext({ ...req, headers: { host: proxyHost } }, 4317, { proxy: true }));
  const proxy = { ...req, headers: { host: proxyHost, origin: 'http://127.0.0.1:4317' } };
  assert.throws(() => requestContext(proxy, 4317, { proxy: true, publicOrigin: 'https://fixture.trycloudflare.com' }));
});

test('允许从链接打开公开首页，跨站导航仍不能读取账号接口', () => {
  const req = { method: 'GET', url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: {
    host: proxyHost, 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' } };
  const network = { proxy: true, publicOrigin: 'https://fixture.trycloudflare.com' };
  assert.equal(requestContext(req, 4317, network).localManagement, false);
  for (const url of ['/android', '/downloads/CodexLink-0.1.0.apk', '/downloads/CodexLink-0.2.0.apk', '/downloads/CodexLink-0.5.1.apk', '/downloads/CodexLink-0.6.1.apk', '/downloads/CodexLink-1.0.0.apk']) assert.equal(requestContext({ ...req, url }, 4317, network).localManagement, false);
  for (const url of ['/downloads/private.json', '/downloads/password.txt', '/downloads/other.apk', '/downloads/CodexLink-0.6.1.apk/../password.txt', '/downloads/CodexLink-0.6.1.apk.exe', '/android/../api/status']) assert.throws(() => requestContext({ ...req, url }, 4317, network));
  assert.throws(() => requestContext({ ...req, url: '/api/status' }, 4317, network));
  assert.throws(() => requestContext({ ...req, method: 'POST' }, 4317, network));
});
test('局域网和外网不能首次设置或停止服务，即使知道正确本机令牌', async t => {
  const f = await fixture(t, false);
  const local = await request(f.main, '/auth'); assert.equal(local.data.setupAllowed, true);
  for (const [server, host] of [[f.main, `192.168.50.20:${f.main.address().port}`], [f.proxy, proxyHost]]) {
    const info = await request(server, '/auth', { host }); assert.equal(info.status, 200); assert.equal(info.data.setupRequired, true); assert.equal(info.data.setupAllowed, false);
    assert.equal((await request(server, '/auth/setup', { host, input: { code: f.access.setupCode, username: 'outsider', password } })).status, 403);
    assert.equal((await request(server, '/server/stop', { host, headers: { 'x-control-token': 'fixture-stop-token' }, input: {} })).status, 403);
  }
  assert.equal(f.access.data.users.length, 0);
});
test('HTTPS 转发登录设置 Secure Cookie，拒绝跨站请求并明确使用轮询', async t => {
  const f = await fixture(t);
  const options = { host: proxyHost, origin: 'https://fixture.trycloudflare.com' };
  const login = await request(f.proxy, '/auth/login', { ...options, input: { username: 'owner', password } });
  assert.equal(login.status, 200); assert.match(login.headers['set-cookie'][0], /; Secure/);
  assert.equal((await request(f.proxy, '/auth', options)).data.connection.updates, 'poll');
  assert.equal((await request(f.proxy, '/status', { ...options, token: f.owner.token })).status, 200);
  assert.equal((await request(f.proxy, '/events', { ...options, token: f.owner.token })).status, 409);
  assert.equal((await request(f.proxy, '/status', { ...options, origin: 'https://evil.example', token: f.owner.token })).status, 403);
  assert.equal((await request(f.proxy, '/auth/logout', { ...options, token: f.owner.token, input: {} })).status, 200);
  assert.equal((await request(f.main, '/status', { token: f.owner.token })).status, 401);
});
test('多网络入口共用私有、共享等级与撤权规则，断线重读不会创建执行', async t => {
  const f = await fixture(t);
  const ddnsto = await f.create({ proxy: true, proxyProvider: 'ddnsto', publicOrigin: 'https://workbench.ddnsto.com' });
  const endpoints = [[f.main, `192.168.50.20:${f.main.address().port}`], [f.proxy, proxyHost], [ddnsto, 'workbench.ddnsto.com']];
  const member = await f.access.createUser(f.owner.user.id, { username: 'reader', password, level: 1 });
  let session = await f.access.login({ username: 'reader', password });
  const cwd = path.join(f.root, 'project'); await mkdir(cwd); await writeFile(path.join(cwd, 'result.txt'), 'NETWORK-CHECK');
  await f.access.transaction(data => {
    data.projects.push({ id: 'project', name: 'private', ownerId: f.owner.user.id, shared: false, level: 3, cwd, source: 'mobile' });
    data.bindings.push({ id: 'task', threadId: null, projectId: 'project', name: 'task' });
  });
  const file = '/tasks/task/file?name=result.txt';
  for (const [server, host] of endpoints) assert.equal((await request(server, file, { host, token: session.token })).status, 404);
  await f.access.transaction(data => { data.projects[0].shared = true; });
  for (const [server, host] of endpoints) assert.equal((await request(server, file, { host, token: session.token })).status, 404);
  await f.access.updateUser(f.owner.user.id, member.id, { level: 3 }); session = await f.access.login({ username: 'reader', password });
  for (const [server, host] of endpoints) {
    assert.equal((await request(server, file, { host, token: session.token })).data, 'NETWORK-CHECK');
    assert.equal((await request(server, '/tasks/task/send', { host, token: session.token, input: { prompt: 'do something' } })).status, 403);
  }
  await f.access.transaction(data => { data.projects[0].shared = false; });
  for (const [server, host] of endpoints) {
    assert.equal((await request(server, '/status', { host, token: session.token })).data.tasks.length, 0);
    assert.equal((await request(server, file, { host, token: session.token })).status, 404);
  }
  assert.equal(f.workbench.tasks.size, 0);
});
