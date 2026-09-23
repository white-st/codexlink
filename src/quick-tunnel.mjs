import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { proxyHost } from './network.mjs';

export function tunnelEnvironment(source, home) {
  const allowed = ['path', 'systemroot', 'windir', 'temp', 'tmp', 'localappdata', 'appdata', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.includes(key.toLowerCase())));
  env.USERPROFILE = home; env.HOME = home;
  return env;
}
export const tunnelAddress = output => output.match(/\|\s+(https:\/\/[a-z0-9-]+\.trycloudflare\.com)\s+\|/)?.[1] || null;

export class QuickTunnel extends EventEmitter {
  constructor({ executable, root, port }) {
    super(); this.options = { executable, root, port }; this.state = { status: 'starting', url: null };
  }
  update(value) { Object.assign(this.state, value); this.emit('change', { ...this.state }); }
  async start() {
    const { executable, root, port } = this.options;
    const home = path.join(root, 'tunnel-home'); await mkdir(home, { recursive: true });
    const env = tunnelEnvironment(process.env, home);
    this.child = spawn(executable, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`,
      '--http-host-header', proxyHost, '--protocol', 'http2', '--loglevel', 'info'], { env, cwd: home, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.on('error', () => this.update({ status: 'failed', url: null, message: '临时外网连接无法启动，请检查本机隧道工具。' }));
    this.child.on('exit', () => this.update({ status: 'stopped', url: null, message: '临时外网连接已停止，本机与同 Wi-Fi 访问不受影响。' }));
    this.diagnostics = '';
    const output = data => {
      this.diagnostics = (this.diagnostics + data.toString()).slice(-16_000);
      const address = tunnelAddress(this.diagnostics);
      if (address && !this.state.url) this.update({ url: address, status: 'connecting' });
      if (/Registered tunnel connection/.test(this.diagnostics) && this.state.status !== 'online') this.update({ status: 'online', message: null });
    };
    this.child.stdout.on('data', output); this.child.stderr.on('data', output);
  }
  async close() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  }
}
