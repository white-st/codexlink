import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assessProbe, probeKeys, decodeOutput, workerEnvironment, runCommand, buildWorkerLaunch, wslProbeInvocation } from '../src/isolation.mjs';
import { CodexClient } from '../src/codex-client.mjs';

test('失败或没有运行的沙盒不能被当作隔离通过，对照组必须先证明探测有效', () => {
  const baseline = Object.fromEntries(probeKeys.map(key => [key, true]));
  const safe = { ...baseline, outsideRead: false, outsideWrite: false, linkRead: false, engineHomeRead: false, networkAccess: false };
  assert.equal(assessProbe(baseline, safe).passed, true);
  assert.equal(assessProbe(baseline, null).status, 'not-executed');
  assert.equal(assessProbe({ ...baseline, networkAccess: false }, safe).status, 'invalid-control');
  for (const key of probeKeys.slice(2)) assert.equal(assessProbe(baseline, { ...safe, [key]: true }).passed, false, key);
  assert.equal(assessProbe(baseline, { ...safe, insideWrite: false }).passed, false);
  assert.equal(assessProbe(baseline, { ...safe, outsideRead: 'false' }).passed, false);
});

test('读取 Windows WSL 的 Unicode 输出，不把提示错误误当作发行版名称', () => {
  const text = '未安装适用于 Linux 的 Windows 子系统。\r\n';
  assert.equal(decodeOutput(Buffer.from(text, 'utf16le')), text);
  assert.equal(decodeOutput(Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')])), text);
  assert.equal(decodeOutput(Buffer.from('codex-cli 0.155.1')), 'codex-cli 0.155.1');
});

test('候选执行器不继承桌面管道、账号密钥、会话或 Windows 互操作环境', () => {
  const filtered = workerEnvironment({ Path: 'test-path', SystemRoot: 'system', OPENAI_API_KEY: 'synthetic', CODEX_HOME: 'host-history', CODEX_APP_TOOLS_PIPE_PATH: 'host-pipe', CODEX_THREAD_ID: 'private-task', WSL_INTEROP: 'host-channel' });
  assert.deepEqual(filtered, { Path: 'test-path', SystemRoot: 'system' });
  const launch = buildWorkerLaunch({ distribution: 'Ubuntu-24.04', projectPath: '/home/codexlink/projects/a', workerHome: '/home/codexlink/state/a' });
  assert.equal(launch.releaseReady, false); assert.ok(launch.pending.includes('windows-interop'));
  assert.ok(launch.args.includes('-i')); assert.ok(launch.args.includes('shell_environment_policy.inherit="none"'));
  assert.equal(launch.args[launch.args.indexOf('--user') + 1], 'codexlink');
  assert.equal(launch.args.some(arg => arg.includes('danger-full-access')), false);
});

test('WSL 启动参数不能注入命令，项目不能覆盖身份目录或采用 root 用户', () => {
  for (const distribution of ['--root', 'Ubuntu;whoami', 'Ubuntu\n--exec', '']) assert.throws(() => wslProbeInvocation(distribution));
  const valid = { distribution: 'Ubuntu-24.04', projectPath: '/home/codexlink/projects/a', workerHome: '/home/codexlink/state/a' };
  for (const projectPath of ['/', '///', '/home/codexlink/state/a', '/home/codexlink', '/x/../etc', 'D:\\project']) assert.throws(() => buildWorkerLaunch({ ...valid, projectPath }));
  assert.throws(() => buildWorkerLaunch({ ...valid, user: 'root' }));
  assert.throws(() => buildWorkerLaunch({ ...valid, user: 'codexlink --exec' }));
  const spaced = buildWorkerLaunch({ ...valid, projectPath: '/home/codexlink/projects/a folder' });
  assert.ok(spaced.args.includes('/home/codexlink/projects/a folder'));
});

test('可注入 stdio 传输进行真实子进程握手，环境和 RPC 请求正确隔离', async t => {
  const env = workerEnvironment({ ...process.env, OPENAI_API_KEY: 'synthetic-secret', CODEX_APP_TOOLS_PIPE_PATH: 'synthetic-pipe' });
  env.CODEX_LINK_TEST_ALLOWED = 'accepted';
  const client = new CodexClient({ executable: process.execPath, args: [path.resolve('test/fixtures/protocol-child.mjs')], env });
  t.after(() => client.close());
  assert.equal((await client.start()).platformOs, 'linux');
  assert.deepEqual(await client.request('test/environment'), { marker: 'accepted', inheritedApiKey: false, inheritedDesktopPipe: false });
  assert.deepEqual(await client.request('echo', { text: '中文，含空格与符号 ; $()' }), { echoed: { text: '中文，含空格与符号 ; $()' } });
});

test('诊断进程不存在、超时、输出超限均返回明确失败', async () => {
  assert.equal((await runCommand('codex-link-does-not-exist', [])).error, 'ENOENT');
  assert.equal((await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 200 })).error, 'TIMEOUT');
  assert.equal((await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(3000))'], { maxBytes: 1000 })).error, 'OUTPUT_LIMIT');
});
