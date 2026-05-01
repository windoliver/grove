import { describe, expect, test } from "bun:test";
import { validatePushBranchFilePaths } from "./gh-cli-client.js";

describe("validatePushBranchFilePaths", () => {
  test("rejects unsafe file paths at the GitHub client sink", () => {
    const files = new Map<string, Uint8Array>([
      ["src/../escape.txt", new TextEncoder().encode("escape")],
    ]);

    expect(() => validatePushBranchFilePaths(files)).toThrow(/artifact name/i);
  });
});
