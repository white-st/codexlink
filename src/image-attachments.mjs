import { failure } from './access-store.mjs';

const invalid = () => failure('图片不完整或格式不受支持，请选择 JPG、PNG 或 WebP 原文件', 415);
export const isImageName = name => /\.(jpe?g|png|webp)$/i.test(name);

// Check the actual container, dimensions and end markers without decoding pixels or executing content.
export function validateImage(name, bytes) {
  const ext = name.split('.').at(-1).toLowerCase();
  if (ext === 'png') {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw invalid();
    let offset = 8, data = false, header = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      if (end > bytes.length) throw invalid();
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (!header) {
        if (type !== 'IHDR' || length !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12)) throw invalid();
        header = true;
      } else if (type === 'IHDR') throw invalid();
      if (type === 'IDAT' && length > 0) data = true;
      if (type === 'IEND') { if (length || end !== bytes.length || !data) throw invalid(); return 'image/png'; }
      offset = end;
    }
  } else if (ext === 'jpg' || ext === 'jpeg') {
    if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw invalid();
    let offset = 2, frame = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (offset + 2 > bytes.length) throw invalid();
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length - 2) throw invalid();
      if ([0xc0,0xc1,0xc2].includes(marker)) {
        if (length < 8 || !bytes.readUInt16BE(offset + 3) || !bytes.readUInt16BE(offset + 5)) throw invalid();
        frame = true;
      }
      if (marker === 0xda) { if (!frame || length < 6 || offset + length >= bytes.length - 2) throw invalid(); return 'image/jpeg'; }
      offset += length;
    }
  } else if (ext === 'webp') {
    if (bytes.length < 26 || bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
    let offset = 12, frame = false;
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString('ascii',offset,offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
      const end = start + length + (length % 2);
      if (end > bytes.length) throw invalid();
      if (type === 'VP8 ' && length >= 10) {
        if (bytes[start] & 1 || bytes.toString('hex',start + 3,start + 6) !== '9d012a' || !(bytes.readUInt16LE(start + 6) & 0x3fff) || !(bytes.readUInt16LE(start + 8) & 0x3fff)) throw invalid();
        frame = true;
      }
      if (type === 'VP8L' && length >= 5) { if (bytes[start] !== 0x2f) throw invalid(); frame = true; }
      if (type === 'ANIM' || type === 'ANMF') throw failure('暂不支持动态 WebP，请先保存为静态 JPG 或 PNG', 415);
      offset = end;
    }
    if (offset === bytes.length && frame) return 'image/webp';
  }
  throw invalid();
}
