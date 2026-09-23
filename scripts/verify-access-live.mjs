import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { AccessStore } from '../src/access-store.mjs';
import { CodexClient } from '../src/codex-client.mjs';
import { createHttpServer } from '../src/server.mjs';

// Read actual existing verification artifacts through the authenticated HTTP boundary.
// Accounts and ownership bindings live only in a new fixture directory.
const registry = JSON.parse(await readFile('.runtime/registry.json', 'utf8'));
const previous = registry.tasks.find(t => t.name === '文件创建与继续修改');
assert.ok(previous, '请先完成第一阶段的文件验证');
await mkdir('.runtime/tests', { recursive: true });
const root = await mkdtemp(path.resolve('.runtime/tests/live-access-'));
const access = new AccessStore(root); const client = new CodexClient(); let server;
const report = { checkedAt: new Date().toISOString(), fixture: root, checks: [] };
try {
  await access.start(); await client.start();
  const workbench = new EventEmitter(); workbench.tasks = new Map([[previous.id, previous]]);
  workbench.readThread = async id => (await client.request('thread/read', { threadId: id, includeTurns: true })).thread;
  server = createHttpServer(workbench, access);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const password = randomBytes(24).toString('base64url');
  const session = await access.setup({ code: access.setupCode, username: 'test_owner', password }, [previous]);
  const other = await access.createUser(session.user.id, { username: 'test_other', password });
  const otherSession = await access.login({ username: other.username, password });
  const headers = { Cookie: `codex_link_session=${session.token}` };
  const history = await fetch(`${url}/api/history/${previous.id}`, { headers });
  assert.equal(history.status, 200); assert.ok((await history.json()).turns.length >= 3);
  report.checks.push('authenticated-real-codex-history');
  const download = await fetch(`${url}/api/tasks/${previous.id}/file?name=verify.txt`, { headers });
  assert.equal(download.status, 200); assert.equal(await download.text(), 'REMOTE-CODEX-STEP-2');
  report.checks.push('authenticated-real-artifact-download');
  const denied = await fetch(`${url}/api/history/${previous.id}`, { headers: { Cookie: `codex_link_session=${otherSession.token}` } });
  assert.equal(denied.status, 404); report.checks.push('second-user-denied-real-history');
  assert.equal(await readFile('.runtime/registry.json', 'utf8'), JSON.stringify(registry, null, 2));
  report.checks.push('original-registry-unchanged'); report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
  server?.closeStreams(); server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  client.close(); await access.close();
  await writeFile('.runtime/access-live-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
