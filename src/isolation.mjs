import { spawn } from 'node:child_process';
import path from 'node:path';

export function decodeOutput(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le').replaceAll('\0', '');
  const sample = buffer.subarray(0, 200);
  if (sample.filter(byte => byte === 0).length > sample.length / 8) return buffer.toString('utf16le').replaceAll('\0', '');
  return buffer.toString('utf8');
}

// Diagnostics use argument arrays, never a shell. No secrets are logged.
export function runCommand(command, args, { cwd, env, input, timeoutMs = 30_000, maxBytes = 128 * 1024 } = {}) {
  return new Promise(resolve => {
    let child, settled = false, size = 0, timer;
    const stdout = [], stderr = [];
    const finish = result => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ...result, stdout: decodeOutput(Buffer.concat(stdout)), stderr: decodeOutput(Buffer.concat(stderr)) });
    };
    try { child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { finish({ exitCode: null, error: error.code || error.message }); return; }
    child.on('error', error => finish({ exitCode: null, error: error.code || error.message }));
    child.on('close', (exitCode, signal) => finish({ exitCode, signal }));
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', data => {
      size += data.length;
      if (size > maxBytes) { child.kill(); finish({ exitCode: null, error: 'OUTPUT_LIMIT' }); }
      else chunks.push(data);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    timer = setTimeout(() => { child.kill(); finish({ exitCode: null, error: 'TIMEOUT' }); }, timeoutMs);
  });
}

export const profileOverride = 'permissions.link-isolation={filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="write"}},network={enabled=false}}';
export const probeKeys = ['insideRead', 'insideWrite', 'outsideRead', 'outsideWrite', 'linkRead', 'engineHomeRead', 'networkAccess'];
export function assessProbe(baseline, restricted) {
  if (!baseline || !probeKeys.every(key => baseline[key] === true)) return { status: 'invalid-control', passed: false };
  if (!restricted || !probeKeys.every(key => typeof restricted[key] === 'boolean')) return { status: 'not-executed', passed: false };
  const passed = restricted.insideRead && restricted.insideWrite && probeKeys.slice(2).every(key => restricted[key] === false);
  return { status: passed ? 'passed' : 'failed', passed };
}

// Only forward operating-system discovery variables to a diagnostic/worker child.
// In particular, do not inherit Codex desktop pipes, account tokens, or task identifiers.
export function workerEnvironment(source = process.env) {
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'userprofile', 'localappdata', 'appdata', 'programdata']);
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toLowerCase())));
}

export function wslProbeInvocation(distribution) {
  if (typeof distribution !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(distribution)) throw new Error('WSL 发行版名称无效');
  return { command: 'wsl.exe', args: ['--distribution', distribution, '--exec', 'python3', '-'] };
}

function linuxPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || /[\0\r\n\\]/.test(value) || value.split('/').some(p => p === '..' || p === '.')) throw new Error('Linux 工作目录必须是明确的绝对路径');
  const normalized = path.posix.normalize(value);
  if (normalized === '/') throw new Error('不能使用 Linux 根目录');
  return normalized.replace(/\/+$/, '');
}
export function buildWorkerLaunch({ distribution, projectPath, workerHome, user = 'codexlink', executable = '/usr/local/bin/codex' }) {
  const { command } = wslProbeInvocation(distribution);
  if (user === 'root' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error('执行器必须使用专用普通 Linux 用户');
  projectPath = linuxPath(projectPath); workerHome = linuxPath(workerHome); executable = linuxPath(executable);
  const home = workerHome + '/home', codexHome = workerHome + '/engine';
  const overlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  if (overlap(projectPath, workerHome)) throw new Error('项目目录不能与执行器身份和配置目录重叠');
  // A candidate launch specification, NOT proof of isolation or authorization to execute.
  // The caller must provision directories and complete the acceptance matrix first.
  const args = ['--distribution', distribution, '--user', user, '--cd', projectPath, '--exec', '/usr/bin/env', '-i',
    'PATH=/usr/local/bin:/usr/bin:/bin', `HOME=${home}`, `CODEX_HOME=${codexHome}`, executable,
    'app-server', '--stdio', '--strict-config', '-c', profileOverride, '-c', 'default_permissions="link-isolation"',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'shell_environment_policy.inherit="none"'];
  for (const feature of ['apps', 'plugins', 'hooks', 'memories', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'multi_agent', 'remote_plugin', 'image_generation', 'code_mode_host', 'shell_snapshot', 'skill_search']) {
    args.push('--disable', feature);
  }
  return { command, args, env: workerEnvironment(), projectPath, workerHome, transport: 'stdio',
    releaseReady: false, pending: ['linux-sandbox-probe', 'windows-interop', 'effective-tool-inventory', 'file-tool-boundaries', 'history-boundaries', 'authentication', 'native-desktop-task-discovery'] };
}
