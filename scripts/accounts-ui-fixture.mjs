// Local synthetic accounts only. Does not connect to Codex or production data.
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessStore } from '../src/access-store.mjs';
import { Workbench } from '../src/workbench.mjs';
import { createHttpServer } from '../src/server.mjs';

await mkdir('.runtime/tests', { recursive: true });
const root = await mkdtemp(path.resolve('.runtime/tests/accounts-ui-'));
const access = new AccessStore(root); await access.start();
const owner = await access.setup({ code: access.setupCode, username: 'admin_fixture', password: 'fixture-admin-068' });
await access.createUser(owner.user.id, { username: 'new_fixture', password: 'fixture-visible-068', level: 2 });
const legacy = await access.createUser(owner.user.id, { username: 'old_fixture', password: 'fixture-legacy-068', level: 1 });
await access.transaction(data => { delete data.users.find(user => user.id === legacy.id).passwordDisplay; });
const client = new EventEmitter(); client.close = () => {};
const workbench = new Workbench({ root, client });
workbench.connected = true; workbench.signedIn = true;
const server = createHttpServer(workbench, access);
const handler = server.listeners('request')[0]; server.removeAllListeners('request');
server.on('request', (req, res) => {
  if (req.url === '/__test/stop' && req.method === 'POST') {
    res.end('stopped');
    setImmediate(async () => { server.closeStreams(); server.closeAllConnections(); server.close(); await workbench.close(); await access.close(); });
    return;
  }
  req.headers.cookie = 'codex_link_session=' + owner.token;
  handler(req, res);
});
server.listen(47817, '127.0.0.1', async () => {
  await writeFile('.runtime/accounts-ui.json', JSON.stringify({ root, port: 47817, legacyId: legacy.id }));
  console.log('Synthetic account UI ready at http://127.0.0.1:47817');
});
