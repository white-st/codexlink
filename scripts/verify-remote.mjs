import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessStore } from '../src/access-store.mjs';
import { createHttpServer } from '../src/server.mjs';
import { QuickTunnel } from '../src/quick-tunnel.mjs';

// Only synthetic accounts/files are exposed; this fixture never starts Codex.
await mkdir('.runtime/tests', { recursive: true });
const root = await mkdtemp(path.resolve('.runtime/tests/remote-'));
const access = new AccessStore(root); await access.start();
const workbench = new EventEmitter(); workbench.tasks = new Map(); workbench.questions = new Map();
const network = { proxy: true, publicOrigin: null };
const server = createHttpServer(workbench, access, { network });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const tunnel = new QuickTunnel({ executable: path.resolve('.runtime/bin/cloudflared.exe'), root, port: server.address().port });
const report = { date: new Date().toISOString(), root, syntheticFixture: true, codexExecuted: false, checks: {} };
let origin;
const request = async (route, { token, input, extraHeaders = {} } = {}) => {
  const response = await fetch(origin + '/api' + route, { signal: AbortSignal.timeout(20_000),
    method: input === undefined ? 'GET' : 'POST', headers: { Origin: origin,
      ...(token ? { Cookie: 'codex_link_session=' + token } : {}),
      ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'X-Local-Client': '1' }), ...extraHeaders },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const text = await response.text(); let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, headers: response.headers, data };
};
try {
  tunnel.on('change', state => { network.publicOrigin = state.url; origin = state.url; console.log('Tunnel state:', state.status); });
  await tunnel.start();
  const deadline = Date.now() + 120_000;
  while (tunnel.state.status !== 'online') {
    if (Date.now() > deadline || ['failed', 'stopped'].includes(tunnel.state.status)) throw new Error('Tunnel did not establish an edge connection');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  report.url = origin;
  // DNS/edge propagation is read-only; never retry a mutation automatically.
  let ready;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { ready = await request('/auth'); if (ready.status === 200) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.equal(ready?.status, 200, 'Public HTTPS endpoint did not become ready');
  assert.equal(ready.data.setupRequired, true); assert.equal(ready.data.setupAllowed, false);
  assert.equal(ready.data.connection.updates, 'poll');
  assert.equal((await request('/auth/setup', { input: { code: access.setupCode, username: 'blocked', password: randomBytes(24).toString('hex') } })).status, 403);
  assert.equal((await request('/server/stop', { input: {} })).status, 403);
  assert.equal((await request('/status')).status, 401);
  report.checks.remoteManagementDenied = true;
  const password = randomBytes(24).toString('base64url');
  const owner = await access.setup({ code: access.setupCode, username: 'owner', password });
  const reader = await access.createUser(owner.user.id, { username: 'reader', password, level: 1 });
  const login = async username => {
    const result = await request('/auth/login', { input: { username, password } });
    assert.equal(result.status, 200); assert.match(result.headers.get('set-cookie'), /; Secure/);
    return result.headers.get('set-cookie').match(/^codex_link_session=([^;]+)/)[1];
  };
  const ownerToken = await login('owner'); let readerToken = await login('reader');
  const cwd = path.join(root, 'project'); await mkdir(cwd); await writeFile(path.join(cwd, 'result.txt'), 'REMOTE-SYNTHETIC-CHECK');
  await access.transaction(data => {
    data.projects.push({ id: 'project', name: 'Fixture only', ownerId: owner.user.id, shared: false, level: 3, cwd, source: 'mobile' });
    data.bindings.push({ id: 'task', threadId: null, projectId: 'project', name: 'Fixture only' });
  });
  const file = '/tasks/task/file?name=result.txt';
  assert.equal((await request(file, { token: ownerToken })).data, 'REMOTE-SYNTHETIC-CHECK');
  assert.equal((await request(file, { token: readerToken })).status, 404);
  await access.transaction(data => { data.projects[0].shared = true; });
  assert.equal((await request(file, { token: readerToken })).status, 404);
  await access.updateUser(owner.user.id, reader.id, { level: 3 });
  assert.equal((await request('/status', { token: readerToken })).status, 401);
  readerToken = await login('reader');
  assert.equal((await request(file, { token: readerToken })).data, 'REMOTE-SYNTHETIC-CHECK');
  assert.equal((await request('/tasks/task/send', { token: readerToken, input: { prompt: 'must be rejected' } })).status, 403);
  assert.equal((await request('/events', { token: readerToken })).status, 409);
  assert.equal((await request('/status', { token: readerToken, extraHeaders: { Origin: 'https://untrusted.example' } })).status, 403);
  await access.transaction(data => { data.projects[0].shared = false; });
  assert.equal((await request('/status', { token: readerToken })).data.tasks.length, 0);
  assert.equal((await request(file, { token: readerToken })).status, 404);
  assert.equal((await request('/auth/logout', { token: readerToken, input: {} })).status, 200);
  assert.equal((await request('/status', { token: readerToken })).status, 401);
  report.checks = { ...report.checks, secureLogin: true, privateFiles: true, sharedLevel: true, sharedReadOnly: true, revocation: true, polling: true, logout: true };
  report.passed = true; console.log('Real HTTPS synthetic account/file verification passed.');
} catch (error) {
  report.passed = false; report.error = error.message; console.error(error.message);
  console.error(tunnel.diagnostics || 'No tunnel diagnostic output'); process.exitCode = 1;
} finally {
  await tunnel.close(); server.closeStreams(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); await access.close();
  await writeFile(path.resolve('.runtime/remote-verification.json'), JSON.stringify(report, null, 2));
}
