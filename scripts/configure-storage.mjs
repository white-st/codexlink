import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { ProjectStorage } from '../src/project-storage.mjs';
import { acquireLock } from '../src/runtime-lock.mjs';
import { isWithin } from '../src/files.mjs';

const root = path.resolve(process.env.CODEX_LINK_RUNTIME || '.runtime');
if (process.argv.length !== 3) throw new Error('用法：npm run storage:configure -- 本机绝对目录；请先停止工作台');
const storage = new ProjectStorage(root, { mobileRoot: process.argv[2] });
await mkdir(root, { recursive: true });
const releases = [];
try {
  for (const name of ['server.lock', 'access.lock', 'workbench.lock']) releases.push(await acquireLock(path.join(root, name)));
  let projects = [];
  try { projects = JSON.parse(await readFile(path.join(root, 'access.json'), 'utf8')).projects; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const project of projects) {
    if (project.source === 'mobile' && (!storage.allows(project.cwd) || isWithin(project.cwd, storage.mobileRoot))) {
      throw new Error('新根目录会与已有手机项目重叠，或使原目录不可用；未修改配置或移动文件');
    }
    if (project.source === 'desktop' && await storage.overlaps(project.cwd)) throw new Error('手机项目根目录与已有电脑项目重叠');
  }
  await mkdir(storage.mobileRoot, { recursive: true });
  const file = path.join(root, 'storage.json');
  await writeFile(file + '.tmp', JSON.stringify({ mobileRoot: storage.mobileRoot }, null, 2));
  await rename(file + '.tmp', file);
  console.log(JSON.stringify({ mobileRoot: storage.mobileRoot, timeZone: 'Asia/Shanghai', layout: 'YYYY-MM-DD/HHmmss_项目名_短编号', existingProjectsMoved: false }, null, 2));
} finally { for (const release of releases.reverse()) await release(); }
