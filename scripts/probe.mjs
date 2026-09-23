import { mkdir, writeFile } from 'node:fs/promises';
import { CodexClient } from '../src/codex-client.mjs';

const client = new CodexClient();
client.on('message', message => {
  if ('id' in message) client.rejectRequest(message.id, 'Read-only probe does not handle actions');
});
try {
  const info = await client.start();
  const account = await client.request('account/read', { refreshToken: false });
  const list = await client.request('thread/list', { limit: 5, useStateDbOnly: true });
  const models = await client.request('model/list', {});
  const report = {
    checkedAt: new Date().toISOString(),
    platform: info.platformOs,
    initialized: true,
    signedIn: Boolean(account.account),
    authType: account.account?.type,
    taskCountInSample: list.data.length,
    taskRead: false,
    modelCount: models.data.length,
    defaultModel: models.data.find(model => model.isDefault)?.id,
  };
  if (list.data.length) {
    const read = await client.request('thread/read', { threadId: list.data[0].id, includeTurns: false });
    report.taskRead = read.thread.id === list.data[0].id;
  }
  await mkdir('.runtime', { recursive: true });
  await writeFile('.runtime/probe.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { client.close(); }
