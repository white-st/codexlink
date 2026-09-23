import { CodexClient } from '../src/codex-client.mjs';
import { buildWorkerLaunch } from '../src/isolation.mjs';

const [distribution, projectPath, workerHome] = process.argv.slice(2);
if (!distribution || !projectPath || !workerHome || process.argv.length !== 5) throw new Error('用法：node scripts/probe-worker.mjs 发行版 Linux项目路径 Linux执行器状态路径');
const plan = buildWorkerLaunch({ distribution, projectPath, workerHome });
const client = new CodexClient({ executable: plan.command, args: plan.args, env: plan.env });
try {
  const info = await client.start();
  if (info.platformOs !== 'linux') throw new Error('连接目标不是 Linux，拒绝作为候选隔离环境');
  const account = await client.request('account/read', { refreshToken: false });
  console.log(JSON.stringify({ handshake: true, platform: info.platformOs, signedIn: Boolean(account.account), releaseReady: false, pending: plan.pending }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client.close(); }
