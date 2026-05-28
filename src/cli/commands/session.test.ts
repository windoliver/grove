import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeNamespace } from "../../core/project-key.js";
import { resolveSessionNexusZoneId } from "./session.js";

const tempRoots: string[] = [];

function makeGroveDir(): string {
  const root = mkdtempSync(join(tmpdir(), "grove-session-zone-"));
  tempRoots.push(root);
  const groveDir = join(root, ".grove");
  mkdirSync(groveDir);
  return groveDir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveSessionNexusZoneId", () => {
  test("uses the persisted grove namespace before env fallback", () => {
    const groveDir = makeGroveDir();
    writeNamespace(groveDir, "project-123/worktree-a");

    expect(resolveSessionNexusZoneId(groveDir, { GROVE_ZONE_ID: "env-zone" })).toBe(
      "project-123/worktree-a",
    );
  });

  test("uses GROVE_ZONE_ID when no namespace file exists", () => {
    const groveDir = makeGroveDir();

    expect(resolveSessionNexusZoneId(groveDir, { GROVE_ZONE_ID: "env-zone" })).toBe("env-zone");
  });

  test("falls back to default when no namespace source is available", () => {
    const groveDir = makeGroveDir();

    expect(resolveSessionNexusZoneId(groveDir, {})).toBe("default");
  });
});
