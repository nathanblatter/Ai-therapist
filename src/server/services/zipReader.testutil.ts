// Test-only helpers for the zip exports (client chart, dataset, IRB packet).
// The services stream through the real archiver in tests, so these read the
// produced bytes back without adding an unzip dependency.
import { PassThrough, type Writable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';

/** Minimal zip reader: walk the central directory, inflate each entry. */
export function readZip(buf: Buffer): Record<string, string> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    entries[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Run a `stream...Zip(x, out)` writer into memory and return the bytes once it resolves. */
export async function zipToBuffer(write: (out: Writable) => Promise<void>): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  await write(out);
  return Buffer.concat(chunks);
}
