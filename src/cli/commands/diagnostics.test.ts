import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProbeRunner } from "../../diagnostics/system.js";
import { initSqliteDb } from "../../local/sqlite-store.js";
import { parseDiagnosticsArgs, runDiagnostics } from "./diagnostics.js";

interface TestGrove {
  readonly projectRoot: string;
  readonly groveDir: string;
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("parseDiagnosticsArgs", () => {
  it("defaults to including db with standard scrub mode", () => {
    const options = parseDiagnosticsArgs([]);

    expect(options.excludeDb).toBe(false);
    expect(options.scrubMode).toBe("standard");
    expect(options.slot).toBeUndefined();
    expect(options.out).toBeUndefined();
  });

  it("parses all supported flags", () => {
    const options = parseDiagnosticsArgs([
      "--exclude-db",
      "--scrub",
      "aggressive",
      "--slot",
      "slot-1",
      "--out",
      "bundle.zip",
    ]);

    expect(options.excludeDb).toBe(true);
    expect(options.scrubMode).toBe("aggressive");
    expect(options.slot).toBe("slot-1");
    expect(options.out).toBe("bundle.zip");
  });

  it("rejects invalid scrub mode", () => {
    expect(() => parseDiagnosticsArgs(["--scrub", "maximum"])).toThrow(/Invalid scrub mode/);
  });
});

describe("runDiagnostics", () => {
  it("writes diagnostics ZIP to explicit output path and prints the path", async () => {
    const grove = createTempGrove("explicit");
    const out = join(grove.projectRoot, "artifacts", "bundle.zip");
    const lines: string[] = [];

    await runDiagnostics(
      {
        excludeDb: false,
        scrubMode: "standard",
        out,
      },
      {
        cwd: grove.projectRoot,
        env: {},
        stdout: (line) => lines.push(line),
        generatedAt: "2026-05-02T12:30:00.000Z",
        systemRunner: fakeSystemRunner,
      },
    );

    expect(existsSync(out)).toBe(true);
    expect(lines).toContain(`Diagnostics bundle written: ${out}`);
    expect(lines.some((line) => line.startsWith("Entries: "))).toBe(true);
    expect(lines.some((line) => line.startsWith("Warnings: "))).toBe(true);
  });

  it("uses timestamped diagnostics ZIP in cwd by default", async () => {
    const grove = createTempGrove("default");
    const expectedOut = join(grove.projectRoot, "grove-diagnostics-2026-05-02T12-30-00Z.zip");
    const lines: string[] = [];

    await runDiagnostics(
      {
        excludeDb: false,
        scrubMode: "standard",
      },
      {
        cwd: grove.projectRoot,
        env: {},
        stdout: (line) => lines.push(line),
        generatedAt: "2026-05-02T12:30:00.000Z",
        systemRunner: fakeSystemRunner,
      },
    );

    expect(existsSync(expectedOut)).toBe(true);
    expect(lines).toContain(`Diagnostics bundle written: ${expectedOut}`);
  });
});

function createTempGrove(name: string): TestGrove {
  const projectRoot = join(
    tmpdir(),
    `grove-diagnostics-${name}-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`,
  );
  tempRoots.push(projectRoot);
  const groveDir = join(projectRoot, ".grove");
  mkdirSync(groveDir, { recursive: true });
  initSqliteDb(join(groveDir, "grove.db")).close();
  return { projectRoot, groveDir };
}

const fakeSystemRunner: ProbeRunner = async (command) => ({
  ok: true,
  stdout: `ok: ${command}\n`,
  stderr: "",
});
