import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePushBranchFilePath, validatePushBranchFilePaths } from "./gh-cli-client.js";

describe("validatePushBranchFilePaths", () => {
  test("rejects unsafe file paths at the GitHub client sink", () => {
    const files = new Map<string, Uint8Array>([
      ["src/../escape.txt", new TextEncoder().encode("escape")],
    ]);

    expect(() => validatePushBranchFilePaths(files)).toThrow(/artifact name/i);
  });
});

describe("resolvePushBranchFilePath", () => {
  test("rejects traversal paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-gh-path-"));
    try {
      await expect(resolvePushBranchFilePath(dir, "../outside.txt")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects symlink escapes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-gh-path-"));
    const outside = await mkdtemp(join(tmpdir(), "grove-gh-outside-"));
    try {
      await symlink(outside, join(dir, "linked"));
      await expect(resolvePushBranchFilePath(dir, "linked/file.txt")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
