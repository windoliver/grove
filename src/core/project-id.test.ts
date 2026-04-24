import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateProjectId,
  isValidProjectId,
  readProjectId,
} from "./project-id.js";

function makeTmpGroveDir(): string {
  const dir = join(
    tmpdir(),
    `grove-project-id-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("isValidProjectId", () => {
  test("accepts a canonical UUIDv4", () => {
    expect(isValidProjectId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("accepts uppercase UUIDv4", () => {
    expect(isValidProjectId("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidProjectId("")).toBe(false);
  });

  test("rejects a UUIDv1", () => {
    expect(isValidProjectId("550e8400-e29b-11d4-a716-446655440000")).toBe(false);
  });

  test("rejects a UUIDv7", () => {
    expect(isValidProjectId("01890abc-def0-7123-8abc-def012345678")).toBe(false);
  });

  test("rejects strings with surrounding whitespace", () => {
    expect(isValidProjectId(" 550e8400-e29b-41d4-a716-446655440000 ")).toBe(false);
  });

  test("rejects non-UUID garbage", () => {
    expect(isValidProjectId("not-a-uuid")).toBe(false);
  });
});

describe("generateProjectId", () => {
  test("returns a valid UUIDv4", () => {
    const id = generateProjectId();
    expect(isValidProjectId(id)).toBe(true);
  });

  test("returns a different UUID each call", () => {
    const a = generateProjectId();
    const b = generateProjectId();
    expect(a).not.toBe(b);
  });
});

describe("readProjectId", () => {
  test("returns null when file is missing", () => {
    const dir = makeTmpGroveDir();
    expect(readProjectId(dir)).toBeNull();
  });

  test("returns null when file is empty", () => {
    const dir = makeTmpGroveDir();
    writeFileSync(join(dir, "project-id"), "");
    expect(readProjectId(dir)).toBeNull();
  });

  test("returns id without trailing newline", () => {
    const dir = makeTmpGroveDir();
    writeFileSync(join(dir, "project-id"), "550e8400-e29b-41d4-a716-446655440000");
    expect(readProjectId(dir)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("returns id with trailing newline", () => {
    const dir = makeTmpGroveDir();
    writeFileSync(join(dir, "project-id"), "550e8400-e29b-41d4-a716-446655440000\n");
    expect(readProjectId(dir)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("throws on malformed contents", () => {
    const dir = makeTmpGroveDir();
    writeFileSync(join(dir, "project-id"), "garbage\n");
    expect(() => readProjectId(dir)).toThrow(/Invalid project id/);
  });
});
