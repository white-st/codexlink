import path from 'node:path';
import { lstat, readdir, realpath, readFile } from 'node:fs/promises';
import { MAX_FILE_BYTES, FILE_LIMIT_LABEL } from './file-limits.mjs';

const oversizedFile = () => Object.assign(new Error(`单个文件不能超过 ${FILE_LIMIT_LABEL}`), { statusCode: 413 });

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export async function resolveFile(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes(':') || path.isAbsolute(name) || path.basename(name) === '.upload-part') {
    throw new Error('文件路径无效');
  }
  const target = path.resolve(root, name);
  if (!isWithin(path.resolve(root), target)) throw new Error('不能访问项目目录之外的文件');
  const actualRoot = await realpath(root);
  const actual = await realpath(target);
  if (!isWithin(actualRoot, actual)) throw new Error('文件链接指向项目目录之外');
  if (!(await lstat(actual)).isFile()) throw new Error('目标不是普通文件');
  return actual;
}

export async function listFiles(root) {
  const result = [];
  async function visit(dir, depth) {
    if (depth > 8 || result.length >= 300) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['.git', 'node_modules', '.upload-part'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else if (entry.isFile()) {
        const info = await lstat(absolute);
        result.push({ name: path.relative(root, absolute).split(path.sep).join('/'), size: info.size });
      }
      if (result.length >= 300) break;
    }
  }
  await visit(root, 0);
  return result;
}

export async function readArtifact(root, name) {
  const file = await resolveFile(root, name);
  const info = await lstat(file);
  if (info.size > MAX_FILE_BYTES) throw oversizedFile();
  const bytes = await readFile(file);
  if (bytes.length > MAX_FILE_BYTES) throw oversizedFile();
  return bytes;
}
