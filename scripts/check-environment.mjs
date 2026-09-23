import { mkdir, writeFile } from 'node:fs/promises';
import { runCommand, workerEnvironment } from '../src/isolation.mjs';

const executable = process.env.CODEX_BIN || 'codex';
const results = await Promise.allSettled([
  runCommand(executable, ['--version']),
  runCommand('wsl.exe', ['--status'], { env: workerEnvironment(), timeoutMs: 15_000 }),
  runCommand('wsl.exe', ['--list', '--quiet'], { env: workerEnvironment(), timeoutMs: 15_000 }),
]);
const [codex, wsl, distributions] = results.map(r => r.status === 'fulfilled' ? r.value : { exitCode: null, error: String(r.reason) });
const report = { checkedAt: new Date().toISOString(), platform: process.platform,
  codex: { available: codex.exitCode === 0, version: codex.stdout?.trim(), error: codex.error },
  wsl: { available: wsl.exitCode === 0, exitCode: wsl.exitCode, detail: (wsl.stderr || wsl.stdout || wsl.error || '').trim(),
    distributions: distributions.exitCode === 0 ? distributions.stdout.split(/\r?\n/).map(v => v.trim()).filter(Boolean) : [], listError: distributions.error },
  releaseReady: false, note: '环境存在不等于执行隔离通过；此命令不安装组件，也不设置管理员账号。' };
await mkdir('.runtime', { recursive: true });
await writeFile('.runtime/environment-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
