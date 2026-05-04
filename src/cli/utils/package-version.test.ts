import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readGrovePackageVersion } from "./package-version.js";

describe("readGrovePackageVersion", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "grove-package-version-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("finds the Grove package root from a built CLI file path", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "grove", version: "9.8.7" }),
    );
    await mkdir(join(tmpDir, "dist", "cli"), { recursive: true });

    const builtCliUrl = pathToFileURL(join(tmpDir, "dist", "cli", "main.js")).href;

    expect(readGrovePackageVersion(builtCliUrl)).toBe("9.8.7");
  });

  test("keeps walking past nested non-Grove package manifests", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "grove", version: "1.2.3" }),
    );
    await mkdir(join(tmpDir, "dist", "cli"), { recursive: true });
    await writeFile(
      join(tmpDir, "dist", "package.json"),
      JSON.stringify({ name: "not-grove", version: "0.0.0" }),
    );

    const bundledChunkUrl = pathToFileURL(join(tmpDir, "dist", "chunk-version.js")).href;

    expect(readGrovePackageVersion(bundledChunkUrl)).toBe("1.2.3");
  });

  test("returns unknown when no Grove package manifest is found", async () => {
    await mkdir(join(tmpDir, "dist"), { recursive: true });

    const bundledChunkUrl = pathToFileURL(join(tmpDir, "dist", "chunk-version.js")).href;

    expect(readGrovePackageVersion(bundledChunkUrl)).toBe("unknown");
  });
});
