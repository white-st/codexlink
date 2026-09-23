import path from 'node:path';
import { AccessStore } from '../src/access-store.mjs';
import { CodexClient } from '../src/codex-client.mjs';
import { importDesktop } from '../src/desktop-import.mjs';

const args = process.argv.slice(2);
const fields = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--owner', '--thread', '--level'].includes(args[i]) || !args[i + 1]) throw new Error('用法：npm run import:desktop -- --owner 账号 --thread 任务编号 [--level 0]');
  fields[args[i]] = args[i + 1];
}
const access = new AccessStore(path.resolve(process.env.CODEX_LINK_RUNTIME || '.runtime'));
const client = new CodexClient();
try {
  if (!fields['--owner'] || !fields['--thread']) throw new Error('需要 --owner 账号 与 --thread 任务编号；请先停止本机服务');
  await access.start(); await client.start();
  const result = await importDesktop(access, client, { username: fields['--owner'].toLowerCase(), threadId: fields['--thread'], projectLevel: Number(fields['--level'] ?? 0) });
  console.log(JSON.stringify(result, null, 2));
  console.log('电脑任务已登记；原目录与 Codex 对话未修改。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client.close(); await access.close(); }
