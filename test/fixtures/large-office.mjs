import { readFile, writeFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

// Add an inert, uncompressed XML part to a real Office fixture; no large binary is committed.
export async function largeOffice(source, target, size) {
  const original = await readFile(source), end = original.length - 22;
  const start = original.readUInt32LE(end + 16), count = original.readUInt16LE(end + 10);
  const name = Buffer.from('docProps/large-test.xml');
  const local = Buffer.alloc(30), central = Buffer.alloc(46), trailer = Buffer.from(original.subarray(end));
  const data = Buffer.alloc(size - original.length - local.length - central.length - name.length * 2, 32);
  data.write('<test>'); data.write('</test>', data.length - 7); const checksum = crc32(data);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(start, 42);
  const added = local.length + name.length + data.length;
  trailer.writeUInt16LE(count + 1, 8); trailer.writeUInt16LE(count + 1, 10);
  trailer.writeUInt32LE(end - start + central.length + name.length, 12); trailer.writeUInt32LE(start + added, 16);
  await writeFile(target, Buffer.concat([original.subarray(0, start), local, name, data, original.subarray(start, end), central, name, trailer]));
}
