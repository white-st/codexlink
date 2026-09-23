import { readFile } from 'node:fs/promises';
import path from 'node:path';
try {
  const { url, controlToken } = JSON.parse(await readFile(path.join(process.env.CODEX_LINK_RUNTIME || '.runtime', 'server.json'), 'utf8'));
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:') throw new Error('服务地址不是本机地址');
  const response = await fetch(url + '/api/server/stop', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Client': '1', 'X-Control-Token': controlToken }, body: '{}' });
  if (!response.ok) throw new Error('停止请求被拒绝');
  console.log('已请求停止本机验证服务。');
} catch (error) { console.error(`未能停止：${error.message}`); process.exitCode = 1; }
