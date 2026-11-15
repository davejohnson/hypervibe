import { inflateRawSync } from 'node:zlib';

export const RELEASE_ARTIFACT_LIMIT = 1_048_576;
export const RELEASE_ARTIFACT_ARCHIVE_LIMIT = RELEASE_ARTIFACT_LIMIT + 65_536;

/** Read bounded release JSON files in memory; never extract provider files. */
export function readReleaseArtifactFilesZip(bytes: Buffer): Record<string, string> {
  try {
    if (bytes.length > RELEASE_ARTIFACT_ARCHIVE_LIMIT) throw new Error();
    // PKWARE APPNOTE 4.3.12/4.3.16. Small release artifacts never need ZIP64,
    // multiple disks, encryption, or executable files.
    let end = bytes.length - 22;
    for (; end >= Math.max(0, bytes.length - 65_557); end--) {
      if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
    }
    if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new Error();
    const entries = bytes.readUInt16LE(end + 10);
    if (entries < 1 || entries > 65 || bytes.readUInt16LE(end + 8) !== entries) throw new Error();
    const centralSize = bytes.readUInt32LE(end + 12);
    const centralStart = bytes.readUInt32LE(end + 16);
    if (centralStart + centralSize !== end) throw new Error();
    let central = centralStart;
    let totalExpanded = 0;
    const files: Record<string, string> = {};
    const names = new Set<string>();
    const ranges: Array<[number, number]> = [];
    for (let entry = 0; entry < entries; entry++) {
      if (bytes.readUInt32LE(central) !== 0x02014b50) throw new Error();
      const flags = bytes.readUInt16LE(central + 8);
      const method = bytes.readUInt16LE(central + 10);
      const crc = bytes.readUInt32LE(central + 16);
      const compressed = bytes.readUInt32LE(central + 20);
      const expanded = bytes.readUInt32LE(central + 24);
      const nameLength = bytes.readUInt16LE(central + 28);
      const extraLength = bytes.readUInt16LE(central + 30);
      const commentLength = bytes.readUInt16LE(central + 32);
      const mode = bytes.readUInt32LE(central + 38) >>> 16;
      const local = bytes.readUInt32LE(central + 42);
      const filename = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(central + 46, central + 46 + nameLength));
      totalExpanded += expanded;
      if (flags & ~0x080e || ![0, 8].includes(method) || totalExpanded > RELEASE_ARTIFACT_LIMIT
          || compressed > RELEASE_ARTIFACT_LIMIT || (mode & 0o170000) === 0o120000
          || bytes.readUInt16LE(central + 34) !== 0 || names.has(filename)
          || !(filename === 'contracts/' || /^(?:[a-z0-9-]+|contracts\/v[1-9][0-9]*)\.json$/.test(filename))
          || (filename === 'contracts/' && expanded !== 0)
          || bytes.readUInt32LE(local) !== 0x04034b50
          || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method
          || bytes.readUInt16LE(local + 26) !== nameLength) throw new Error();
      const dataStart = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
      const dataEnd = dataStart + compressed;
      if (bytes.subarray(local + 30, local + 30 + nameLength).toString('utf8') !== filename
          || dataEnd > centralStart || ranges.some(([start, end]) => local < end && dataEnd > start)) throw new Error();
      ranges.push([local, dataEnd]);
      const payload = bytes.subarray(dataStart, dataEnd);
      const json = method === 8 ? inflateRawSync(payload, { maxOutputLength: RELEASE_ARTIFACT_LIMIT }) : payload;
      let actualCrc = 0xffffffff;
      for (const value of json) {
        actualCrc ^= value;
        for (let bit = 0; bit < 8; bit++) actualCrc = (actualCrc >>> 1) ^ ((actualCrc & 1) ? 0xedb88320 : 0);
      }
      if (json.length !== expanded || ((actualCrc ^ 0xffffffff) >>> 0) !== crc) throw new Error();
      names.add(filename);
      if (filename !== 'contracts/') files[filename] = new TextDecoder('utf-8', { fatal: true }).decode(json);
      central += 46 + nameLength + extraLength + commentLength;
    }
    if (central !== end) throw new Error();
    return files;
  } catch {
    throw new Error('Invalid release artifact: expected bounded JSON files in a valid ZIP.');
  }
}

export function readReleaseArtifactZip(bytes: Buffer, filename: string): unknown {
  const files = readReleaseArtifactFilesZip(bytes);
  try {
    if (Object.keys(files).length !== 1 || !Object.hasOwn(files, filename)) throw new Error();
    return JSON.parse(files[filename]);
  } catch { throw new Error('Invalid release artifact: expected one bounded JSON file in a valid ZIP.'); }
}

export async function readBoundedArtifactBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Release artifact has no response body.');
  const chunks: Buffer[] = [];
  let size = 0;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Release artifact download timed out.'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > RELEASE_ARTIFACT_ARCHIVE_LIMIT) throw new Error('Release artifact exceeds the bounded archive limit.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {});
  }
}
