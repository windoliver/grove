import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendServerKey,
  generateApiKey,
  writeClientKey,
} from "./project-key.js";

// detectWorktreeName requires a real git repo — tested in integration only

describe("generateApiKey", () => {
  it("returns a string matching grv_ + 64 hex chars", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^grv_[0-9a-f]{64}$/);
  });

  it("returns a different key on each call", () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
});

describe("writeClientKey / appendServerKey", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `grove-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writeClientKey writes grv_ key to api-key file", () => {
    const key = generateApiKey();
    writeClientKey(dir, key);
    const content = readFileSync(join(dir, "api-key"), "utf8").trim();
    expect(content).toBe(key);
  });

  it("writeClientKey overwrites on second call (idempotent)", () => {
    writeClientKey(dir, "grv_" + "a".repeat(64));
    writeClientKey(dir, "grv_" + "b".repeat(64));
    const content = readFileSync(join(dir, "api-key"), "utf8").trim();
    expect(content).toBe("grv_" + "b".repeat(64));
  });

  it("appendServerKey creates server-keys.yaml with correct structure", () => {
    const key = "grv_" + "a".repeat(64);
    appendServerKey(dir, key, "uuid-1234/main");
    const raw = readFileSync(join(dir, "server-keys.yaml"), "utf8");
    expect(raw).toContain("version: 1");
    expect(raw).toContain(key);
    expect(raw).toContain("uuid-1234/main");
  });

  it("appendServerKey appends a second key without removing the first", () => {
    const keyA = "grv_" + "a".repeat(64);
    const keyB = "grv_" + "b".repeat(64);
    appendServerKey(dir, keyA, "uuid-1234/main");
    appendServerKey(dir, keyB, "uuid-1234/main");
    const raw = readFileSync(join(dir, "server-keys.yaml"), "utf8");
    expect(raw).toContain(keyA);
    expect(raw).toContain(keyB);
  });

  it("appendServerKey creates server-keys.yaml if absent", () => {
    expect(existsSync(join(dir, "server-keys.yaml"))).toBe(false);
    appendServerKey(dir, "grv_" + "c".repeat(64), "uuid/worktree");
    expect(existsSync(join(dir, "server-keys.yaml"))).toBe(true);
  });

  it("writeClientKey creates api-key with 0o600 permissions", () => {
    const key = generateApiKey();
    writeClientKey(dir, key);
    const mode = statSync(join(dir, "api-key")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("appendServerKey creates server-keys.yaml with 0o600 permissions", () => {
    appendServerKey(dir, generateApiKey(), "uuid/ns");
    const mode = statSync(join(dir, "server-keys.yaml")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
