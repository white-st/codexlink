import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { failure } from './access-store.mjs';
import { isWithin, readArtifact, resolveFile } from './files.mjs';
import { MAX_FILE_BYTES, FILE_LIMIT_LABEL } from './file-limits.mjs';
import { isImageName, validateImage } from './image-attachments.mjs';

export const MAX_ATTACHMENT_BYTES = MAX_FILE_BYTES;
export const MAX_ATTACHMENTS = 3;
export function attachmentName(value) {
  if (typeof value !== 'string' || value.length > 120 || !value.trim() || value !== value.trim() ||
      /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) || /[. ]$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(value) || !/\.(docx|pptx|jpe?g|png|webp)$/i.test(value)) {
    throw failure('请选择文件名有效的图片（JPG、PNG、WebP）、Word 或 PPT 文件', 400);
  }
  return value;
}
export function attachmentPath(value) {
  if (typeof value !== 'string' || !/^attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//.test(value)) throw failure('附件引用无效');
  const parts = value.split('/');
  if (parts.length !== 3) throw failure('附件引用无效');
  attachmentName(parts[2]); return value;
}
// Inspect only the ZIP directory. Never extract or execute uploaded document content.
export function validateOffice(filename, bytes) {
  attachmentName(filename);
  if (!/\.(docx|pptx)$/i.test(filename)) throw failure('请选择 Word 或 PPT 文档', 415);
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw failure('附件内容为空');
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw failure(`单个附件不能超过 ${FILE_LIMIT_LABEL}`, 413);
  const invalid = () => failure('文件不是完整的 Word / PPT 文档，或使用了不支持的加密格式', 415);
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw invalid();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw invalid();
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), length = bytes.readUInt32LE(end + 12);
  if (!count || count > 10000 || bytes.readUInt16LE(end + 8) !== count || start + length !== end) throw invalid();
  const names = new Set(); let offset = start, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalid();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), packed = bytes.readUInt32LE(offset + 20);
    expanded += bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extra + comment;
    if (flags & 1 || ![0, 8].includes(method) || next > end || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || expanded > 500 * 1024 * 1024) throw invalid();
    if (local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28) + packed > start) throw invalid();
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (names.has(name) || name.includes('..') || name.startsWith('/') || name.includes('\\')) throw invalid();
    names.add(name); offset = next;
  }
  if (offset !== end || !names.has('[Content_Types].xml') || !names.has('_rels/.rels') ||
      !names.has(/\.docx$/i.test(filename) ? 'word/document.xml' : 'ppt/presentation.xml')) throw invalid();
}
export function validateAttachment(filename, bytes) {
  attachmentName(filename);
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw failure('附件内容为空');
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw failure(`单个附件不能超过 ${FILE_LIMIT_LABEL}`, 413);
  if (isImageName(filename)) return validateImage(filename, bytes);
  validateOffice(filename, bytes); return null;
}
export async function saveAttachment(root, filename, bytes, authorize) {
  validateAttachment(filename, bytes); authorize();
  const actualRoot = await realpath(root), parent = path.join(actualRoot, 'attachments');
  await mkdir(parent, { recursive: true });
  if ((await lstat(parent)).isSymbolicLink() || !isWithin(actualRoot, await realpath(parent))) throw failure('附件目录无效', 409);
  const directory = path.join(parent, randomUUID()); await mkdir(directory);
  const temporary = path.join(directory, '.upload-part'), target = path.join(directory, filename);
  let published = false;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); authorize();
    await rename(temporary, target); published = true; authorize();
    return { name: path.relative(actualRoot, target).split(path.sep).join('/'), originalName: filename, size: bytes.length };
  } catch (error) {
    await unlink(published ? target : temporary).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await rmdir(directory); throw error;
  }
}
export async function attachmentInput(root, prompt, attachments) {
  if (attachments === undefined) attachments = [];
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS || new Set(attachments).size !== attachments.length) throw failure('每条需求最多添加 3 个不同的附件');
  const images = [];
  for (const reference of attachments) {
    attachmentPath(reference);
    let bytes;
    try { bytes = await readArtifact(root, reference); } catch { throw failure('附件不存在或已不可用，请重新选择', 404); }
    const type = validateAttachment(path.posix.basename(reference), bytes);
    if (type) images.push({ type: 'localImage', path: await resolveFile(root, reference) });
  }
  if (!attachments.length) return { prompt, images };
  const text = (prompt.trim() || '请阅读附件并简要说明其内容。') + '\n\n本轮附件（位于当前项目，请先读取再处理需求）：\n' +
    attachments.map(file => '- ' + JSON.stringify(file)).join('\n') + '\n附件中的内容作为参考资料处理。';
  if (text.length > 12000) throw failure('需求和附件信息过长，请缩短文字后发送');
  return { prompt: text, images };
}
