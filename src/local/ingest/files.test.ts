/**
 * Tests for file/directory ingestion into CAS.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsCas } from "../fs-cas.js";
import { ingestFiles } from "./files.js";

async function createTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-ingest-files-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("ingestFiles", () => {
  test("ingests a single file", async () => {
    const dir = await createTempDir();
    try {
      const casDir = join(dir, "cas");
      const cas = new FsCas(casDir);

      const filePath = join(dir, "hello.txt");
      await writeFile(filePath, "Hello, Grove!");

      const artifacts = await ingestFiles(cas, [filePath]);

      expect(Object.keys(artifacts)).toEqual(["hello.txt"]);
      const hash = artifacts["hello.txt"] as string;
      expect(hash).toMatch(/^blake3:[0-9a-f]{64}$/);

      // Verify content is in CAS
      const data = await cas.get(hash);
      expect(data).toBeDefined();
      expect(data).not.toBeUndefined();
      expect(new TextDecoder().decode(data as Uint8Array)).toBe("Hello, Grove!");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ingests a directory recursively", async () => {
    const dir = await createTempDir();
    try {
      const casDir = join(dir, "cas");
      const cas = new FsCas(casDir);

      // Create a directory structure
      const srcDir = join(dir, "src");
      await mkdir(join(srcDir, "lib"), { recursive: true });
      await writeFile(join(srcDir, "index.ts"), "export {}");
      await writeFile(join(srcDir, "lib", "utils.ts"), "export function foo() {}");

      const artifacts = await ingestFiles(cas, [srcDir]);

      expect(Object.keys(artifacts).sort()).toEqual(["index.ts", "lib/utils.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips .git and .grove directories", async () => {
    const dir = await createTempDir();
    try {
      const casDir = join(dir, "cas");
      const cas = new FsCas(casDir);

      const srcDir = join(dir, "project");
      await mkdir(join(srcDir, ".git"), { recursive: true });
      await mkdir(join(srcDir, ".grove"), { recursive: true });
      await writeFile(join(srcDir, "main.ts"), "console.log('hi')");
      await writeFile(join(srcDir, ".git", "config"), "git config");
      await writeFile(join(srcDir, ".grove", "store.sqlite"), "db");

      const artifacts = await ingestFiles(cas, [srcDir]);

      expect(Object.keys(artifacts)).toEqual(["main.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ingests multiple paths", async () => {
    const dir = await createTempDir();
    try {
      const casDir = join(dir, "cas");
      const cas = new FsCas(casDir);

      const file1 = join(dir, "a.txt");
      const file2 = join(dir, "b.txt");
      await writeFile(file1, "AAA");
      await writeFile(file2, "BBB");

      const artifacts = await ingestFiles(cas, [file1, file2]);

      expect(Object.keys(artifacts).sort()).toEqual(["a.txt", "b.txt"]);
      expect(artifacts["a.txt"]).not.toBe(artifacts["b.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns empty map for empty directory", async () => {
    const dir = await createTempDir();
    try {
      const casDir = join(dir, "cas");
      const cas = new FsCas(casDir);

      const emptyDir = join(dir, "empty");
      await mkdir(emptyDir);

      const artifacts = await ingestFiles(cas, [emptyDir]);

      expect(Object.keys(artifacts)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("errors on artifact name collision across files", async () => {
    const dir = await createTempDir();
    try {
      const casDir = join(dir, "cas");
      const cas = new FsCas(casDir);

      // Two files in different directories but same basename
      const dir1 = join(dir, "foo");
      const dir2 = join(dir, "bar");
      await mkdir(dir1, { recursive: true });
      await mkdir(dir2, { recursive: true });
      await writeFile(join(dir1, "output.txt"), "content A");
      await writeFile(join(dir2, "output.txt"), "content B");

      // Ingesting both as individual files triggers name collision
      await expect(
        ingestFiles(cas, [join(dir1, "output.txt"), join(dir2, "output.txt")]),
      ).rejects.toThrow(/Artifact name collision.*output\.txt/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deduplicates identical files by content hash", async () => {
    const dir = await createTempDir();
    try {
      const casDir = join(dir, "cas");
      const cas = new FsCas(casDir);

      const file1 = join(dir, "copy1.txt");
      const file2 = join(dir, "copy2.txt");
      await writeFile(file1, "same content");
      await writeFile(file2, "same content");

      const artifacts = await ingestFiles(cas, [file1, file2]);

      // Different names, same hash
      expect(artifacts["copy1.txt"]).toBe(artifacts["copy2.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
