/**
 * Tests for markdown report ingestion into CAS.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsCas } from "../fs-cas.js";
import { ingestReport } from "./report.js";

async function createTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-ingest-report-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("ingestReport", () => {
  test("ingests a markdown file as a single artifact", async () => {
    const dir = await createTempDir();
    try {
      const casDir = join(dir, "cas");
      const cas = new FsCas(casDir);

      const reportPath = join(dir, "report.md");
      const content = "# Analysis Report\n\nFindings: everything works.";
      await writeFile(reportPath, content);

      const artifacts = await ingestReport(cas, reportPath);

      expect(Object.keys(artifacts)).toEqual(["report"]);
      const hash = artifacts.report as string;
      expect(hash).toMatch(/^blake3:[0-9a-f]{64}$/);

      // Verify content
      const data = await cas.get(hash);
      expect(data).toBeDefined();
      expect(data).not.toBeUndefined();
      expect(new TextDecoder().decode(data as Uint8Array)).toBe(content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws on nonexistent file", async () => {
    const dir = await createTempDir();
    try {
      const casDir = join(dir, "cas");
      const cas = new FsCas(casDir);

      await expect(ingestReport(cas, join(dir, "missing.md"))).rejects.toThrow(
        /Report file not found/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
