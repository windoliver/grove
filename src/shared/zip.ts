/**
 * Tiny ZIP writer for diagnostics bundles.
 *
 * Uses method 0 (stored) so Grove does not need a runtime compression
 * dependency or the external `zip` binary. Supports classic ZIP limits only.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
const STORED_ZIP_FLAGS = 0x0800;
const MAX_ZIP32 = 0xffffffff;
const MAX_UINT16 = 0xffff;

export interface ZipEntryInput {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ZipEntryOutput {
  readonly path: string;
  readonly bytes: Uint8Array;
}

interface CentralDirectoryRecord {
  readonly pathBytes: Uint8Array;
  readonly crc: number;
  readonly size: number;
  readonly localOffset: number;
}

const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createStoredZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const seen = new Set<string>();
  const chunks: Uint8Array[] = [];
  const centralRecords: CentralDirectoryRecord[] = [];
  let offset = 0;

  for (const entry of entries) {
    validateEntryPath(entry.path);
    if (seen.has(entry.path)) {
      throw new Error(`duplicate zip entry path: ${entry.path}`);
    }
    seen.add(entry.path);

    const pathBytes = textEncoder.encode(entry.path);
    if (pathBytes.length > MAX_UINT16) {
      throw new Error(`zip entry path is too long: ${entry.path}`);
    }
    if (entry.bytes.length > MAX_ZIP32) {
      throw new Error(`zip entry exceeds ZIP32 size limit: ${entry.path}; retry with --exclude-db`);
    }
    if (offset > MAX_ZIP32) {
      throw new Error("zip archive exceeds ZIP32 offset limit; retry with --exclude-db");
    }

    const crc = crc32(entry.bytes);
    const local = new Uint8Array(30 + pathBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, STORED_ZIP_FLAGS, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.bytes.length, true);
    view.setUint32(22, entry.bytes.length, true);
    view.setUint16(26, pathBytes.length, true);
    view.setUint16(28, 0, true);
    local.set(pathBytes, 30);

    chunks.push(local, entry.bytes);
    centralRecords.push({ pathBytes, crc, size: entry.bytes.length, localOffset: offset });
    offset += local.length + entry.bytes.length;
  }

  const centralStart = offset;
  for (const record of centralRecords) {
    const central = new Uint8Array(46 + record.pathBytes.length);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, STORED_ZIP_FLAGS, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, DOS_TIME, true);
    view.setUint16(14, DOS_DATE, true);
    view.setUint32(16, record.crc, true);
    view.setUint32(20, record.size, true);
    view.setUint32(24, record.size, true);
    view.setUint16(28, record.pathBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, record.localOffset, true);
    central.set(record.pathBytes, 46);
    chunks.push(central);
    offset += central.length;
  }

  const centralSize = offset - centralStart;
  if (centralRecords.length > MAX_UINT16 || centralStart > MAX_ZIP32 || centralSize > MAX_ZIP32) {
    throw new Error("zip archive exceeds ZIP32 central directory limit; retry with --exclude-db");
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, centralRecords.length, true);
  eocdView.setUint16(10, centralRecords.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralStart, true);
  eocdView.setUint16(20, 0, true);
  chunks.push(eocd);
  offset += eocd.length;

  const out = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) throw new Error("invalid zip: truncated uint16");
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error("invalid zip: truncated uint32");
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  for (let offset = bytes.length - 22; offset >= 0; offset--) {
    if (readUInt32(bytes, offset) === 0x06054b50) return offset;
  }
  throw new Error("invalid zip: missing end of central directory");
}

function decodeEntryPath(bytes: Uint8Array): string {
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new Error("invalid zip: filename is not valid UTF-8");
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function readStoredZip(bytes: Uint8Array): readonly ZipEntryOutput[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const eocdCommentLength = readUInt16(bytes, eocdOffset + 20);
  if (eocdCommentLength !== 0 || eocdOffset + 22 !== bytes.length) {
    throw new Error("unsupported zip end of central directory comment or trailing data");
  }
  const entryCount = readUInt16(bytes, eocdOffset + 8);
  const centralSize = readUInt32(bytes, eocdOffset + 12);
  const centralStart = readUInt32(bytes, eocdOffset + 16);
  let centralOffset = centralStart;
  const centralEnd = centralOffset + centralSize;
  if (centralEnd !== eocdOffset) {
    throw new Error("invalid zip: central directory exceeds archive bounds");
  }
  const entries: ZipEntryOutput[] = [];
  const seen = new Set<string>();
  let expectedLocalOffset = 0;

  for (let index = 0; index < entryCount; index++) {
    const fixedHeaderEnd = centralOffset + 46;
    if (fixedHeaderEnd > centralEnd) {
      throw new Error("invalid zip: central directory record exceeds declared size");
    }
    if (readUInt32(bytes, centralOffset) !== 0x02014b50) {
      throw new Error("invalid zip: missing central directory record");
    }
    const flags = readUInt16(bytes, centralOffset + 8);
    if (flags !== STORED_ZIP_FLAGS) {
      throw new Error(`unsupported zip flags: ${flags}`);
    }
    const compressionMethod = readUInt16(bytes, centralOffset + 10);
    if (compressionMethod !== 0) {
      throw new Error(`unsupported zip compression method: ${compressionMethod}`);
    }
    const expectedCrc = readUInt32(bytes, centralOffset + 16);
    const compressedSize = readUInt32(bytes, centralOffset + 20);
    const uncompressedSize = readUInt32(bytes, centralOffset + 24);
    if (compressedSize !== uncompressedSize) {
      throw new Error("invalid stored zip: compressed and uncompressed sizes differ");
    }
    const nameLength = readUInt16(bytes, centralOffset + 28);
    const extraLength = readUInt16(bytes, centralOffset + 30);
    const commentLength = readUInt16(bytes, centralOffset + 32);
    const localOffset = readUInt32(bytes, centralOffset + 42);
    const nameStart = centralOffset + 46;
    const variableFieldEnd = nameStart + nameLength + extraLength + commentLength;
    if (variableFieldEnd > centralEnd) {
      throw new Error("invalid zip: central directory variable fields exceed declared size");
    }
    if (extraLength !== 0 || commentLength !== 0) {
      throw new Error("unsupported zip central directory extra/comment fields");
    }
    const centralNameBytes = bytes.slice(nameStart, nameStart + nameLength);

    if (localOffset !== expectedLocalOffset) {
      throw new Error("invalid zip: local offset gap or unaccounted local record");
    }
    if (localOffset >= centralStart) {
      throw new Error("invalid zip: local offset overlaps central directory");
    }
    if (localOffset + 30 > centralStart) {
      throw new Error("invalid zip: local header overlaps central directory");
    }
    if (readUInt32(bytes, localOffset) !== 0x04034b50) {
      throw new Error("invalid zip: missing local file header");
    }
    const localFlags = readUInt16(bytes, localOffset + 6);
    if (localFlags !== STORED_ZIP_FLAGS) {
      throw new Error(`unsupported zip flags: ${localFlags}`);
    }
    const localCompressionMethod = readUInt16(bytes, localOffset + 8);
    if (localCompressionMethod !== 0) {
      throw new Error(`unsupported zip compression method: ${localCompressionMethod}`);
    }
    const localCrc = readUInt32(bytes, localOffset + 14);
    const localCompressedSize = readUInt32(bytes, localOffset + 18);
    const localUncompressedSize = readUInt32(bytes, localOffset + 22);
    if (
      localCrc !== expectedCrc ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize
    ) {
      throw new Error("zip local header metadata mismatch");
    }
    const localNameLength = readUInt16(bytes, localOffset + 26);
    const localExtraLength = readUInt16(bytes, localOffset + 28);
    if (localExtraLength !== 0) {
      throw new Error("unsupported zip local extra fields");
    }
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    if (dataStart > centralStart) {
      throw new Error("invalid zip: local header overlaps central directory");
    }
    const localNameBytes = bytes.slice(localNameStart, localNameStart + localNameLength);
    if (!bytesEqual(localNameBytes, centralNameBytes)) {
      throw new Error("zip local header path filename bytes mismatch");
    }
    const name = decodeEntryPath(centralNameBytes);
    validateEntryPath(name);
    if (seen.has(name)) throw new Error(`duplicate zip entry path: ${name}`);
    seen.add(name);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralStart) {
      throw new Error("invalid zip: entry data overlaps central directory");
    }
    expectedLocalOffset = dataEnd;
    const entryBytes = bytes.slice(dataStart, dataEnd);
    const actualCrc = crc32(entryBytes);
    if (actualCrc !== expectedCrc) {
      throw new Error(`zip crc mismatch for ${name}`);
    }
    entries.push({ path: name, bytes: entryBytes });
    centralOffset = variableFieldEnd;
  }

  if (centralOffset !== centralEnd) {
    throw new Error("invalid zip: central directory size mismatch");
  }
  if (expectedLocalOffset !== centralStart) {
    throw new Error("invalid zip: unaccounted local records before central directory");
  }

  return entries;
}

function validateEntryPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:/.test(path) ||
    path.endsWith("/") ||
    path.includes("\\") ||
    hasControlCharacter(path)
  ) {
    throw new Error(`unsafe zip entry path: ${path}`);
  }

  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error(`unsafe zip entry path: ${path}`);
    }
  }
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const codePoint = value.charCodeAt(i);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}
