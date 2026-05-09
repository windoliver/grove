import { describe, expect, test } from "bun:test";
import { crc32, createStoredZip, readStoredZip } from "./zip.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const UTF8_ZIP_FLAGS = 0x0800;

interface ParsedEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly crc: number;
}

interface ParsedCentralDirectoryEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}

function writeUInt32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function writeUInt16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function createStoredLocalHeader(
  flags: number,
  pathBytes: Uint8Array,
  entryBytes: Uint8Array,
): Uint8Array {
  const localHeader = new Uint8Array(30 + pathBytes.length + entryBytes.length);
  writeUInt32(localHeader, 0, 0x04034b50);
  writeUInt16(localHeader, 4, 20);
  writeUInt16(localHeader, 6, flags);
  writeUInt16(localHeader, 8, 0);
  writeUInt32(localHeader, 14, crc32(entryBytes));
  writeUInt32(localHeader, 18, entryBytes.length);
  writeUInt32(localHeader, 22, entryBytes.length);
  writeUInt16(localHeader, 26, pathBytes.length);
  writeUInt16(localHeader, 28, 0);
  localHeader.set(pathBytes, 30);
  localHeader.set(entryBytes, 30 + pathBytes.length);
  return localHeader;
}

function parseStoredZip(bytes: Uint8Array): readonly ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let offset = 0;
  while (readUInt32(bytes, offset) === 0x04034b50) {
    const crc = readUInt32(bytes, offset + 14);
    const size = readUInt32(bytes, offset + 18);
    const nameLength = readUInt16(bytes, offset + 26);
    const extraLength = readUInt16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = textDecoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    const data = bytes.slice(dataStart, dataStart + size);
    entries.push({ name, bytes: data, crc });
    offset = dataStart + size;
  }
  return entries;
}

function parseCentralDirectory(bytes: Uint8Array): readonly ParsedCentralDirectoryEntry[] {
  const eocdOffset = bytes.length - 22;
  const entryCount = readUInt16(bytes, eocdOffset + 8);
  let offset = readUInt32(bytes, eocdOffset + 16);
  const entries: ParsedCentralDirectoryEntry[] = [];

  for (let index = 0; index < entryCount; index++) {
    const nameLength = readUInt16(bytes, offset + 28);
    const extraLength = readUInt16(bytes, offset + 30);
    const commentLength = readUInt16(bytes, offset + 32);
    const nameStart = offset + 46;
    entries.push({
      name: textDecoder.decode(bytes.slice(nameStart, nameStart + nameLength)),
      compressionMethod: readUInt16(bytes, offset + 10),
      crc: readUInt32(bytes, offset + 16),
      compressedSize: readUInt32(bytes, offset + 20),
      uncompressedSize: readUInt32(bytes, offset + 24),
      localOffset: readUInt32(bytes, offset + 42),
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

describe("crc32", () => {
  test("matches the standard check value", () => {
    expect(crc32(textEncoder.encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("createStoredZip", () => {
  test("readStoredZip round-trips writer output", () => {
    const zip = createStoredZip([
      { path: "SKILL.md", bytes: textEncoder.encode("skill") },
      { path: "references/guide.md", bytes: textEncoder.encode("guide") },
    ]);

    const entries = readStoredZip(zip);

    expect(entries.map((entry) => entry.path)).toEqual(["SKILL.md", "references/guide.md"]);
    expect(textDecoder.decode(entries[0]?.bytes)).toBe("skill");
    expect(textDecoder.decode(entries[1]?.bytes)).toBe("guide");
  });

  test("readStoredZip rejects CRC mismatch", () => {
    const zip = createStoredZip([{ path: "SKILL.md", bytes: textEncoder.encode("skill") }]);
    const corrupted = new Uint8Array(zip);
    corrupted[30 + textEncoder.encode("SKILL.md").length] =
      (corrupted[30 + textEncoder.encode("SKILL.md").length] ?? 0) ^ 0xff;

    expect(() => readStoredZip(corrupted)).toThrow(/crc/i);
  });

  test("readStoredZip rejects unsupported compression methods", () => {
    const zip = createStoredZip([{ path: "SKILL.md", bytes: textEncoder.encode("skill") }]);
    const compressed = new Uint8Array(zip);
    compressed[8] = 8;

    expect(() => readStoredZip(compressed)).toThrow(/compression method/i);
  });

  test("readStoredZip rejects unsafe central-directory paths", () => {
    const unsafe = createStoredZip([{ path: "SKILL.md", bytes: textEncoder.encode("skill") }]);
    const patched = new Uint8Array(unsafe);
    const eocdOffset = patched.length - 22;
    const centralStart = readUInt32(patched, eocdOffset + 16);
    patched.set(textEncoder.encode("/KILL.md"), 30);
    patched.set(textEncoder.encode("/KILL.md"), centralStart + 46);

    expect(() => readStoredZip(patched)).toThrow(/unsafe zip entry/i);
  });

  test("readStoredZip rejects central directory fields past EOCD size", () => {
    const zip = createStoredZip([{ path: "SKILL.md", bytes: textEncoder.encode("skill") }]);
    const patched = new Uint8Array(zip);
    const eocdOffset = patched.length - 22;
    const centralStart = readUInt32(patched, eocdOffset + 16);
    writeUInt16(patched, centralStart + 30, 1);

    expect(() => readStoredZip(patched)).toThrow(/central directory/i);
  });

  test("readStoredZip rejects inconsistent EOCD central directory size", () => {
    const zip = createStoredZip([{ path: "SKILL.md", bytes: textEncoder.encode("skill") }]);
    const patched = new Uint8Array(zip);
    const eocdOffset = patched.length - 22;
    const centralSize = readUInt32(patched, eocdOffset + 12);
    writeUInt32(patched, eocdOffset + 12, centralSize - 1);

    expect(() => readStoredZip(patched)).toThrow(/central directory/i);
  });

  test("readStoredZip rejects mismatched local and central paths", () => {
    const zip = createStoredZip([{ path: "safe.txt", bytes: textEncoder.encode("skill") }]);
    const patched = new Uint8Array(zip);
    patched.set(textEncoder.encode("evil.txt"), 30);

    expect(() => readStoredZip(patched)).toThrow(/local header path/i);
  });

  test("readStoredZip rejects mismatched local sizes", () => {
    const zip = createStoredZip([{ path: "safe.txt", bytes: textEncoder.encode("skill") }]);
    const patched = new Uint8Array(zip);
    writeUInt32(patched, 18, textEncoder.encode("skill").length + 1);

    expect(() => readStoredZip(patched)).toThrow(/local header/i);
  });

  test("readStoredZip rejects mismatched local CRC", () => {
    const zip = createStoredZip([{ path: "safe.txt", bytes: textEncoder.encode("skill") }]);
    const patched = new Uint8Array(zip);
    writeUInt32(patched, 14, 0);

    expect(() => readStoredZip(patched)).toThrow(/local header/i);
  });

  test("readStoredZip rejects unsupported general purpose flags", () => {
    const zip = createStoredZip([{ path: "safe.txt", bytes: textEncoder.encode("skill") }]);
    const patched = new Uint8Array(zip);
    const eocdOffset = patched.length - 22;
    const centralStart = readUInt32(patched, eocdOffset + 16);
    writeUInt16(patched, 6, 1);
    writeUInt16(patched, centralStart + 8, 1);

    expect(() => readStoredZip(patched)).toThrow(/flags/i);
  });

  test("readStoredZip rejects central directory extra fields", () => {
    const zip = createStoredZip([{ path: "safe.txt", bytes: textEncoder.encode("skill") }]);
    const eocdOffset = zip.length - 22;
    const centralStart = readUInt32(zip, eocdOffset + 16);
    const centralSize = readUInt32(zip, eocdOffset + 12);
    const patched = new Uint8Array(zip.length + 1);
    const patchedEocdOffset = eocdOffset + 1;
    patched.set(zip.slice(0, eocdOffset), 0);
    patched[eocdOffset] = 0;
    patched.set(zip.slice(eocdOffset), patchedEocdOffset);
    writeUInt16(patched, centralStart + 30, 1);
    writeUInt32(patched, patchedEocdOffset + 12, centralSize + 1);

    expect(() => readStoredZip(patched)).toThrow(/extra|comment|unsupported zip fields/i);
  });

  test("readStoredZip rejects central directory file comments", () => {
    const zip = createStoredZip([{ path: "safe.txt", bytes: textEncoder.encode("skill") }]);
    const eocdOffset = zip.length - 22;
    const centralStart = readUInt32(zip, eocdOffset + 16);
    const centralSize = readUInt32(zip, eocdOffset + 12);
    const patched = new Uint8Array(zip.length + 1);
    const patchedEocdOffset = eocdOffset + 1;
    patched.set(zip.slice(0, eocdOffset), 0);
    patched[eocdOffset] = 0;
    patched.set(zip.slice(eocdOffset), patchedEocdOffset);
    writeUInt16(patched, centralStart + 32, 1);
    writeUInt32(patched, patchedEocdOffset + 12, centralSize + 1);

    expect(() => readStoredZip(patched)).toThrow(/extra|comment|unsupported zip fields/i);
  });

  test("readStoredZip rejects local extra fields", () => {
    const entryBytes = textEncoder.encode("skill");
    const zip = createStoredZip([{ path: "safe.txt", bytes: entryBytes }]);
    const eocdOffset = zip.length - 22;
    const centralStart = readUInt32(zip, eocdOffset + 16);
    const dataStart = 30 + textEncoder.encode("safe.txt").length;
    const patched = new Uint8Array(zip.length + 1);
    patched.set(zip.slice(0, dataStart), 0);
    patched[dataStart] = 0;
    patched.set(zip.slice(dataStart), dataStart + 1);
    const patchedEocdOffset = eocdOffset + 1;
    writeUInt16(patched, 28, 1);
    writeUInt32(patched, patchedEocdOffset + 16, centralStart + 1);

    expect(() => readStoredZip(patched)).toThrow(/extra|unsupported zip fields/i);
  });

  test("readStoredZip rejects local data overlapping the central directory", () => {
    const entryBytes = textEncoder.encode("skill");
    const pathBytes = textEncoder.encode("safe.txt");
    const zip = createStoredZip([{ path: "safe.txt", bytes: entryBytes }]);
    const eocdOffset = zip.length - 22;
    const centralStart = readUInt32(zip, eocdOffset + 16);
    const centralSize = readUInt32(zip, eocdOffset + 12);
    const centralNameLength = readUInt16(zip, centralStart + 28);
    const flags = readUInt16(zip, centralStart + 8);
    const fakeLocalOffset = centralStart + 46 + centralNameLength;
    const fakeLocalHeader = createStoredLocalHeader(flags, pathBytes, entryBytes);
    const patched = new Uint8Array(zip.length + fakeLocalHeader.length);
    const patchedEocdOffset = eocdOffset + fakeLocalHeader.length;
    patched.set(zip.slice(0, eocdOffset), 0);
    patched.set(fakeLocalHeader, eocdOffset);
    patched.set(zip.slice(eocdOffset), patchedEocdOffset);
    writeUInt16(patched, centralStart + 30, fakeLocalHeader.length);
    writeUInt32(patched, centralStart + 42, fakeLocalOffset);
    writeUInt32(patched, patchedEocdOffset + 12, centralSize + fakeLocalHeader.length);

    expect(() => readStoredZip(patched)).toThrow(/central directory|overlap|local offset/i);
  });

  test("readStoredZip rejects prepended local-area gaps", () => {
    const zip = createStoredZip([{ path: "safe.txt", bytes: textEncoder.encode("skill") }]);
    const eocdOffset = zip.length - 22;
    const centralStart = readUInt32(zip, eocdOffset + 16);
    const patched = new Uint8Array(zip.length + 1);
    patched[0] = 0;
    patched.set(zip, 1);
    const patchedCentralStart = centralStart + 1;
    const patchedEocdOffset = eocdOffset + 1;
    writeUInt32(patched, patchedCentralStart + 42, 1);
    writeUInt32(patched, patchedEocdOffset + 16, patchedCentralStart);

    expect(() => readStoredZip(patched)).toThrow(/local offset|gap|unaccounted/i);
  });

  test("readStoredZip rejects unreferenced local records before the central directory", () => {
    const zip = createStoredZip([{ path: "safe.txt", bytes: textEncoder.encode("skill") }]);
    const eocdOffset = zip.length - 22;
    const centralStart = readUInt32(zip, eocdOffset + 16);
    const unusedLocal = createStoredLocalHeader(
      UTF8_ZIP_FLAGS,
      textEncoder.encode("unused.txt"),
      textEncoder.encode("unused"),
    );
    const patched = new Uint8Array(zip.length + unusedLocal.length);
    patched.set(zip.slice(0, centralStart), 0);
    patched.set(unusedLocal, centralStart);
    patched.set(zip.slice(centralStart, eocdOffset), centralStart + unusedLocal.length);
    patched.set(zip.slice(eocdOffset), eocdOffset + unusedLocal.length);
    writeUInt32(patched, eocdOffset + unusedLocal.length + 16, centralStart + unusedLocal.length);

    expect(() => readStoredZip(patched)).toThrow(/local records|local area|unaccounted/i);
  });

  test("readStoredZip rejects trailing data after the end of central directory", () => {
    const zip = createStoredZip([{ path: "safe.txt", bytes: textEncoder.encode("skill") }]);
    const patched = new Uint8Array(zip.length + 1);
    patched.set(zip, 0);

    expect(() => readStoredZip(patched)).toThrow(/trailing|comment|end of central directory/i);
  });

  test("readStoredZip compares local and central filename bytes before decoding", () => {
    const zip = createStoredZip([{ path: "aa.txt", bytes: textEncoder.encode("skill") }]);
    const patched = new Uint8Array(zip);
    const eocdOffset = patched.length - 22;
    const centralStart = readUInt32(patched, eocdOffset + 16);
    patched.set(Uint8Array.of(0xc0, 0x80, 0x2e, 0x74, 0x78, 0x74), 30);
    patched.set(Uint8Array.of(0xc1, 0x81, 0x2e, 0x74, 0x78, 0x74), centralStart + 46);

    expect(() => readStoredZip(patched)).toThrow(/filename|path mismatch/i);
  });

  test("readStoredZip rejects malformed UTF-8 filename bytes", () => {
    const zip = createStoredZip([{ path: "aa.txt", bytes: textEncoder.encode("skill") }]);
    const patched = new Uint8Array(zip);
    const eocdOffset = patched.length - 22;
    const centralStart = readUInt32(patched, eocdOffset + 16);
    const malformedPath = Uint8Array.of(0xc0, 0x80, 0x2e, 0x74, 0x78, 0x74);
    patched.set(malformedPath, 30);
    patched.set(malformedPath, centralStart + 46);

    expect(() => readStoredZip(patched)).toThrow(/utf-8|filename/i);
  });

  test("writes UTF-8 general purpose flags for stored entries", () => {
    const zip = createStoredZip([{ path: "safe.txt", bytes: textEncoder.encode("skill") }]);
    const eocdOffset = zip.length - 22;
    const centralStart = readUInt32(zip, eocdOffset + 16);

    expect(readUInt16(zip, 6)).toBe(UTF8_ZIP_FLAGS);
    expect(readUInt16(zip, centralStart + 8)).toBe(UTF8_ZIP_FLAGS);
  });

  test("round-trips multiple stored entries", () => {
    const zip = createStoredZip([
      { path: "meta.json", bytes: textEncoder.encode('{"ok":true}') },
      { path: "logs/runtime.log", bytes: textEncoder.encode("line one\nline two\n") },
    ]);

    const entries = parseStoredZip(zip);

    expect(entries.map((entry) => entry.name)).toEqual(["meta.json", "logs/runtime.log"]);
    expect(textDecoder.decode(entries[0]?.bytes)).toBe('{"ok":true}');
    expect(textDecoder.decode(entries[1]?.bytes)).toBe("line one\nline two\n");
    expect(entries[0]?.crc).toBe(crc32(textEncoder.encode('{"ok":true}')));
  });

  test("writes EOCD and central directory records for stored entries", () => {
    const firstBytes = textEncoder.encode('{"ok":true}');
    const secondBytes = textEncoder.encode("line one\nline two\n");
    const zip = createStoredZip([
      { path: "meta.json", bytes: firstBytes },
      { path: "logs/runtime.log", bytes: secondBytes },
    ]);
    const eocdOffset = zip.length - 22;
    const centralStart = readUInt32(zip, eocdOffset + 16);
    const centralSize = readUInt32(zip, eocdOffset + 12);
    const expectedSecondLocalOffset =
      30 + textEncoder.encode("meta.json").length + firstBytes.length;

    expect(readUInt32(zip, eocdOffset)).toBe(0x06054b50);
    expect(readUInt16(zip, eocdOffset + 8)).toBe(2);
    expect(readUInt16(zip, eocdOffset + 10)).toBe(2);
    expect(centralStart + centralSize).toBe(eocdOffset);
    expect(readUInt32(zip, centralStart)).toBe(0x02014b50);

    const centralEntries = parseCentralDirectory(zip);
    expect(centralEntries.map((entry) => entry.name)).toEqual(["meta.json", "logs/runtime.log"]);
    expect(centralEntries.map((entry) => entry.compressionMethod)).toEqual([0, 0]);
    expect(centralEntries.map((entry) => entry.crc)).toEqual([
      crc32(firstBytes),
      crc32(secondBytes),
    ]);
    expect(centralEntries.map((entry) => entry.compressedSize)).toEqual([
      firstBytes.length,
      secondBytes.length,
    ]);
    expect(centralEntries.map((entry) => entry.uncompressedSize)).toEqual([
      firstBytes.length,
      secondBytes.length,
    ]);
    expect(centralEntries.map((entry) => entry.localOffset)).toEqual([
      0,
      expectedSecondLocalOffset,
    ]);
  });

  test("rejects duplicate paths", () => {
    expect(() =>
      createStoredZip([
        { path: "same.txt", bytes: textEncoder.encode("a") },
        { path: "same.txt", bytes: textEncoder.encode("b") },
      ]),
    ).toThrow(/duplicate zip entry/i);
  });

  test("rejects absolute and parent-relative paths", () => {
    expect(() => createStoredZip([{ path: "/abs.txt", bytes: new Uint8Array() }])).toThrow(
      /unsafe zip entry/i,
    );
    expect(() => createStoredZip([{ path: "C:/abs.txt", bytes: new Uint8Array() }])).toThrow(
      /unsafe zip entry/i,
    );
    expect(() => createStoredZip([{ path: "../up.txt", bytes: new Uint8Array() }])).toThrow(
      /unsafe zip entry/i,
    );
  });

  test("rejects dot, empty segment, drive-relative, and control-character paths", () => {
    const unsafePaths = [
      ".",
      "./meta.json",
      "logs//runtime.log",
      "C:drive-relative.txt",
      "nul\u0000byte.txt",
      "control\u001fbyte.txt",
    ];

    for (const path of unsafePaths) {
      expect(() => createStoredZip([{ path, bytes: new Uint8Array() }])).toThrow(
        /unsafe zip entry/i,
      );
    }
  });

  test("rejects directory entries", () => {
    expect(() => createStoredZip([{ path: "dir/", bytes: new Uint8Array() }])).toThrow(
      /unsafe zip entry/i,
    );
  });

  test("recommends excluding the database when an entry exceeds ZIP32 limits", () => {
    const oversizedBytes = { length: 0x100000000 } as unknown as Uint8Array;

    expect(() => createStoredZip([{ path: "db.sqlite", bytes: oversizedBytes }])).toThrow(
      /--exclude-db/,
    );
  });
});
