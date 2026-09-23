import { mkdir, mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommand, profileOverride, assessProbe, workerEnvironment, wslProbeInvocation } from '../src/isolation.mjs';

const options = process.argv.slice(2);
if (options.length && !(options.length === 2 && options[0] === '--wsl')) throw new Error('用法：npm run verify:isolation -- [--wsl 发行版]');
await mkdir('.runtime/isolation', { recursive: true });
const root = await mkdtemp(path.resolve('.runtime/isolation/probe-'));
const report = { version: 2, checkedAt: new Date().toISOString(), root, cases: [], fileIsolationPassed: false,
  toolAndHistoryIsolationPassed: false, releaseReady: false };
if (options[0] === '--wsl') {
  const launch = wslProbeInvocation(options[1]);
  const result = await runCommand(launch.command, launch.args, {
    input: await readFile(new URL('./linux/isolation-probe.py', import.meta.url)), env: workerEnvironment(), timeoutMs: 60_000,
  });
  let evidence;
  try { evidence = JSON.parse(result.stdout); } catch {}
  report.backend = 'wsl'; report.distribution = options[1];
  report.cases.push(evidence || { status: 'not-executed', ...result });
  // Require structured booleans from a successful control and actual sandbox execution.
  report.fileIsolationPassed = result.exitCode === 0 && evidence?.sandboxExitCode === 0 && assessProbe(evidence?.baseline, evidence?.restricted).passed;
} else {
  report.backend = 'windows-native';
  const own = path.join(root, 'alice'), other = path.join(root, 'bob'), engineHome = path.join(root, 'engine-home');
  await mkdir(own); await mkdir(other); await mkdir(engineHome);
  const marker = 'CANARY-' + randomUUID();
  await writeFile(path.join(own, 'own.txt'), marker);
  await writeFile(path.join(other, 'private.txt'), marker);
  await writeFile(path.join(engineHome, 'fake-auth.txt'), marker);
  await symlink(other, path.join(own, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const listener = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  try {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
function CanRead($p){try{return ([IO.File]::ReadAllText($p) -eq ${quote(marker)})}catch{return $false}}
function CanWrite($p){try{[IO.File]::WriteAllText($p,'PROBE-WRITE');return $true}catch{return $false}}
$network=$false;$socket=New-Object Net.Sockets.TcpClient
try{$pending=$socket.ConnectAsync('127.0.0.1',${listener.address().port});$network=$pending.Wait(1000) -and $socket.Connected}catch{}finally{$socket.Dispose()}
[ordered]@{insideRead=(CanRead ${quote(path.join(own, 'own.txt'))});insideWrite=(CanWrite ${quote(path.join(own, 'output.txt'))});outsideRead=(CanRead ${quote(path.join(other, 'private.txt'))});outsideWrite=(CanWrite ${quote(path.join(other, 'output.txt'))});linkRead=(CanRead ${quote(path.join(own, 'link', 'private.txt'))});engineHomeRead=(CanRead ${quote(path.join(engineHome, 'fake-auth.txt'))});networkAccess=$network} | ConvertTo-Json -Compress`;
    const command = ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    const env = workerEnvironment();
    const baselineResult = await runCommand(command[0], command.slice(1), { cwd: own, env });
    let baseline;
    try { baseline = JSON.parse(baselineResult.stdout); } catch {}
    report.baseline = { ...baselineResult, checks: baseline };
    const executable = process.env.CODEX_BIN || 'codex';
    report.codexVersion = (await runCommand(executable, ['--version'])).stdout.trim();
    for (const mode of ['elevated', 'unelevated']) {
      const args = ['sandbox', '-C', own, '-c', profileOverride, '-c', `windows.sandbox="${mode}"`, '-P', 'link-isolation', ...command];
      const result = await runCommand(executable, args, { cwd: own, env });
      let restricted;
      try { restricted = JSON.parse(result.stdout); } catch {}
      const assessment = assessProbe(baseline, restricted);
      if (result.exitCode !== 0 && /cannot enforce|requires effective|requires the elevated|not supported|unsupported/i.test(result.stderr)) assessment.status = 'unsupported-policy';
      const passed = baselineResult.exitCode === 0 && result.exitCode === 0 && assessment.passed;
      report.cases.push({ mode, ...result, checks: restricted, status: assessment.status, passed });
    }
    report.fileIsolationPassed = report.cases.some(item => item.passed);
  } finally { await new Promise(resolve => listener.close(resolve)); }
}
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
await writeFile('.runtime/isolation-verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.fileIsolationPassed) process.exitCode = 1;
