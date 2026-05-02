import { describe, expect, test } from "bun:test";
import { createStoredZip, crc32 } from "./zip.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface ParsedEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly crc: number;
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
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

describe("crc32", () => {
  test("matches the standard check value", () => {
    expect(crc32(textEncoder.encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("createStoredZip", () => {
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
