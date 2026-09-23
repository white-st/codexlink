import { open, readFile, unlink } from 'node:fs/promises';

export async function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        if (await readFile(file, 'utf8').catch(() => '') === String(process.pid)) await unlink(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(file, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('运行锁无效，不能安全启动');
      let alive = true;
      try { process.kill(pid, 0); }
      catch (check) { if (check.code === 'ESRCH') alive = false; else throw check; }
      if (alive) throw new Error('已有本机验证进程在使用这个工作目录，请先停止它');
      await unlink(file);
    }
  }
  throw new Error('未能取得运行锁');
}
