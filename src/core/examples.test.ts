/**
 * CI guard: parse all examples/\*\*\/grove.md files against parseGroveContract.
 *
 * This test ensures that example GROVE.md files always use valid field names
 * and schema-conformant values. Without this guard, field-name drift goes
 * undetected until an agent or user copy-pastes the example and gets a parse
 * error from parseGroveContract.
 *
 * New examples are automatically covered — no manual registration required.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { parseGroveContract } from "./contract.js";

describe("example grove.md files", () => {
  test("all examples/*/grove.md files parse against the canonical contract schema", async () => {
    const { Glob } = await import("bun");

    // Resolve the repo root relative to this file's compile-time location.
    // process.cwd() is the repo root when running `bun test` from the project root.
    const repoRoot = process.cwd();
    const pattern = "examples/**/grove.md";

    const files: string[] = [];
    for (const rel of new Glob(pattern).scanSync({ cwd: repoRoot, absolute: false })) {
      files.push(join(repoRoot, rel));
    }

    expect(files.length).toBeGreaterThan(0);

    const failures: Array<{ file: string; error: string }> = [];

    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, "utf8");
        parseGroveContract(content);
      } catch (err) {
        failures.push({
          file: filePath.replace(repoRoot + "/", ""),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failures.length > 0) {
      const report = failures
        .map((f) => `  ${f.file}:\n    ${f.error}`)
        .join("\n");
      throw new Error(
        `${failures.length} example grove.md file(s) failed to parse:\n${report}\n\n` +
          "Fix the field names to match the canonical contract schema in src/core/contract.ts",
      );
    }
  });
});
