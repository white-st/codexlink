import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lanAddresses, validateNetwork } from '../src/network.mjs';

const mode = process.argv[2];
if (!['local', 'lan', 'lan-remote', 'ddnsto'].includes(mode) || (mode === 'ddnsto' ? process.argv.length > 5 : process.argv.length !== 3)) throw new Error('用法：node scripts/configure-network.mjs local|lan|lan-remote，或 ddnsto [HTTPS地址] [本机端口]');
const root = path.resolve(process.env.CODEX_LINK_RUNTIME || '.runtime');
const addresses = mode === 'local' ? [] : lanAddresses();
if (mode !== 'local' && !addresses.length) throw new Error('未发现可用的局域网 IPv4 地址');
const config = validateNetwork({ lanAddresses: addresses, quickTunnel: mode === 'lan-remote',
  ...(mode === 'ddnsto' ? { ddnsto: { origin: process.argv[3] || null, port: process.argv[4] === undefined ? 4318 : Number(process.argv[4]) } } : {}) });
await mkdir(root, { recursive: true });
await writeFile(path.join(root, 'network.json'), JSON.stringify(config, null, 2));
console.log(JSON.stringify({ mode, ...config, message: '配置已保存，重启工作台后生效。不修改防火墙或路由器。' }, null, 2));
