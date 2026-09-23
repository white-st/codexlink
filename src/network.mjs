import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { failure } from './access-store.mjs';
import { isApkPath } from './releases.mjs';

export const proxyHost = 'codex-link-tunnel.invalid';
export const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
export function privateIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function lanAddresses() {
  return Object.values(networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal && privateIPv4(i.address)).map(i => i.address);
}
export function sameLanPeer(peer, addresses, interfaces = networkInterfaces()) {
  const address = peer?.replace(/^::ffff:/, '');
  if (isIP(address || '') !== 4) return false;
  const number = ip => ip.split('.').reduce((n, part) => (n << 8) | Number(part), 0);
  return Object.values(interfaces).flat().some(i => addresses.includes(i.address) && isIP(i.netmask || '') === 4 &&
    (number(address) & number(i.netmask)) === (number(i.address) & number(i.netmask)));
}
export function ddnstoOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写 DDNSTO 的 HTTPS 访问地址');
  let url;
  try { url = new URL(value); } catch { throw new Error('DDNSTO 访问地址格式无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      url.hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(url.hostname) ||
      isIP(url.hostname) || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) {
    throw new Error('DDNSTO 地址必须是 HTTPS 域名，不能包含账号、路径、查询参数或本机地址');
  }
  return url.origin;
}
export function validateNetwork(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['lanAddresses', 'quickTunnel', 'ddnsto'].includes(k))) throw new Error('网络配置格式无效');
  const addresses = value.lanAddresses ?? [];
  if (!Array.isArray(addresses) || !addresses.every(privateIPv4) || new Set(addresses).size !== addresses.length) throw new Error('局域网地址必须是明确的 IPv4 私网地址');
  if ('quickTunnel' in value && typeof value.quickTunnel !== 'boolean') throw new Error('临时隧道开关无效');
  let ddnsto = null;
  if (value.ddnsto !== undefined && value.ddnsto !== null) {
    const input = value.ddnsto;
    if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['origin', 'port'].includes(k))) throw new Error('DDNSTO 配置格式无效');
    const port = input.port ?? 4318;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('DDNSTO 本机端口应为 1024–65535');
    ddnsto = { origin: input.origin == null ? null : ddnstoOrigin(input.origin), port };
    if (value.quickTunnel) throw new Error('DDNSTO 与临时 Cloudflare 隧道不能同时启用');
  }
  return { lanAddresses: addresses, quickTunnel: value.quickTunnel ?? false, ddnsto };
}
export function requestContext(req, port, { lanAddresses: addresses = [], proxy = false, publicOrigin = null, proxyProvider = 'cloudflare' } = {}) {
  const peerLocal = loopback(req.socket.remoteAddress);
  const forwarded = Object.keys(req.headers).some(k => k === 'forwarded' || k.startsWith('x-forwarded-') || k === 'cf-connecting-ip');
  let origin, localManagement = false;
  if (proxy) {
    if (!peerLocal) throw failure('不允许的转发入口', 403);
    if (!publicOrigin) throw failure('外网连接正在准备，请稍后刷新', 503);
    const parsed = new URL(publicOrigin);
    if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin) throw new Error('外网地址必须是 HTTPS origin');
    const hosts = proxyProvider === 'ddnsto' ? [`127.0.0.1:${port}`, parsed.host, ...(parsed.port ? [] : [`${parsed.hostname}:443`])] : [proxyHost];
    if (!hosts.includes(req.headers.host)) throw failure('不允许的转发入口', 403);
    origin = publicOrigin;
  } else {
    const localHost = `127.0.0.1:${port}`;
    const hosts = [localHost, ...addresses.map(address => `${address}:${port}`)];
    if (!hosts.includes(req.headers.host)) throw failure('访问地址不在允许列表中', 403);
    if (req.headers.host === localHost && !peerLocal) throw failure('本机地址不能用于远程访问', 403);
    if (!peerLocal && !sameLanPeer(req.socket.remoteAddress, addresses)) throw failure('此入口仅允许同一局域网访问', 403);
    if (forwarded) throw failure('此入口不接受代理转发', 403);
    origin = `http://${req.headers.host}`;
    localManagement = peerLocal && req.headers.host === localHost;
  }
  // Opening the public landing page from a link is safe; data APIs remain same-origin.
  const navigationPath = req.url?.split('?')[0];
  const landingNavigation = req.method === 'GET' && (['/', '/android'].includes(navigationPath) || isApkPath(navigationPath)) && req.headers['sec-fetch-dest'] === 'document';
  if ((req.headers.origin && req.headers.origin !== origin) || (!landingNavigation && ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']))) throw failure('请求来源不被允许', 403);
  return { origin, localManagement, secure: proxy, updates: proxy ? 'poll' : 'events', kind: proxy ? 'remote' : localManagement ? 'local' : 'lan' };
}
