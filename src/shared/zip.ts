/**
 * Tiny ZIP writer for diagnostics bundles.
 *
 * Uses method 0 (stored) so Grove does not need a runtime compression
 * dependency or the external `zip` binary. Supports classic ZIP limits only.
 */

const textEncoder = new TextEncoder();
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
const MAX_ZIP32 = 0xffffffff;
const MAX_UINT16 = 0xffff;

export interface ZipEntryInput {
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
    view.setUint16(6, 0x0800, true);
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
    view.setUint16(8, 0x0800, true);
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
