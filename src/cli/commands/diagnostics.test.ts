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

  it("shows help for --help", () => {
    expect(() => parseDiagnosticsArgs(["--help"])).toThrow(/grove diagnostics[\s\S]*Usage:/);
  });

  it("shows help for -h", () => {
    expect(() => parseDiagnosticsArgs(["-h"])).toThrow(/grove diagnostics[\s\S]*Usage:/);
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

  it("resolves relative grove override from injected cwd", async () => {
    const cwd = makeTempDir("override-parent");
    const projectRoot = join(cwd, "child");
    const groveDir = join(projectRoot, ".grove");
    mkdirSync(groveDir, { recursive: true });
    initSqliteDb(join(groveDir, "grove.db")).close();
    const out = join(cwd, "bundle.zip");

    await runDiagnostics(
      {
        excludeDb: false,
        scrubMode: "standard",
        out,
      },
      {
        cwd,
        groveOverride: "child",
        env: {},
        generatedAt: "2026-05-02T12:30:00.000Z",
        systemRunner: fakeSystemRunner,
      },
    );

    expect(existsSync(out)).toBe(true);
  });

  it("written zip contains expected diagnostics entries", async () => {
    const grove = createTempGrove("zip-content");
    const out = join(grove.projectRoot, "diag-full.zip");

    await runDiagnostics(
      {
        excludeDb: false,
        scrubMode: "standard",
        out,
      },
      {
        cwd: grove.projectRoot,
        env: {
          HOME: "/Users/tester",
          GROVE_AGENT_ID: "agent-test",
        },
        generatedAt: "2026-05-02T12:30:00.000Z",
        systemRunner: fakeSystemRunner,
      },
    );

    const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
    const names = zipEntryNames(bytes);

    expect(names).toContain("meta.json");
    expect(names).toContain("README.md");
    expect(names).toContain("db/grove.db");
    expect(names).toContain("db/contributions-recent.jsonl");
    expect(names).toContain("operator-primitives/availability.json");
    expect(names).toContain("system/process-tree.txt");
  });
});

function createTempGrove(name: string): TestGrove {
  const projectRoot = makeTempDir(name);
  const groveDir = join(projectRoot, ".grove");
  mkdirSync(groveDir, { recursive: true });
  initSqliteDb(join(groveDir, "grove.db")).close();
  return { projectRoot, groveDir };
}

function makeTempDir(name: string): string {
  const projectRoot = join(
    tmpdir(),
    `grove-diagnostics-${name}-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`,
  );
  tempRoots.push(projectRoot);
  return projectRoot;
}

const fakeSystemRunner: ProbeRunner = async (command) => ({
  ok: true,
  stdout: `ok: ${command}\n`,
  stderr: "",
});

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (
    (byteAt(bytes, offset) |
      (byteAt(bytes, offset + 1) << 8) |
      (byteAt(bytes, offset + 2) << 16) |
      (byteAt(bytes, offset + 3) << 24)) >>>
    0
  );
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8);
}

function byteAt(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0;
}

function zipEntryNames(bytes: Uint8Array): readonly string[] {
  const names: string[] = [];
  let offset = 0;

  while (offset + 30 <= bytes.length && readUInt32(bytes, offset) === 0x04034b50) {
    const size = readUInt32(bytes, offset + 18);
    const nameLength = readUInt16(bytes, offset + 26);
    const extraLength = readUInt16(bytes, offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;

    names.push(new TextDecoder().decode(bytes.slice(nameStart, nameEnd)));
    offset = nameStart + nameLength + extraLength + size;
  }

  return names;
}
