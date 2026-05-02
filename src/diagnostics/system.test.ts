import { afterEach, describe, expect, mock, test } from "bun:test";
import { promisify } from "node:util";
import type { DiagnosticEntry } from "./sqlite-export.js";
import type { ProbeRunner } from "./system.js";

afterEach(async () => {
  mock.restore();
});

describe("collectSystemSnapshots", () => {
  test("collects system probes in a stable order", async () => {
    const { collectSystemSnapshots } = await importSystemModule("stable-order");
    const commands: string[] = [];
    const runner: ProbeRunner = async (command) => {
      commands.push(command);
      return {
        ok: true,
        stdout: `output for ${command}`,
        stderr: "",
      };
    };

    const entries = await collectSystemSnapshots({
      projectRoot: "/tmp/project's root",
      groveDir: "/tmp/project's root/.grove",
      runner,
    });

    expect(commands).toEqual([
      "ps -axo pid,ppid,comm,args",
      "du -sh '/tmp/project'\\''s root/.grove' '/tmp/project'\\''s root'",
      "lsof -nP | grep -E 'grove|bun|codex|claude|nexus' || true",
    ]);
    expect(entries.map((entry) => entry.path)).toEqual([
      "system/process-tree.txt",
      "system/disk-usage.txt",
      "system/open-fds.txt",
    ]);
    expect(decodeEntry(getEntry(entries, "system/process-tree.txt"))).toContain(
      "output for ps -axo pid,ppid,comm,args",
    );
  });

  test("records fallback text when a probe fails", async () => {
    const { collectSystemSnapshots } = await importSystemModule("stderr-failure");
    const runner: ProbeRunner = async () => ({
      ok: false,
      stdout: "",
      stderr: "permission denied",
    });

    const entries = await collectSystemSnapshots({
      projectRoot: "/tmp/project",
      groveDir: "/tmp/project/.grove",
      runner,
    });

    const processTree = decodeEntry(getEntry(entries, "system/process-tree.txt"));
    expect(processTree).toContain("Probe failed");
    expect(processTree).toContain("permission denied");
  });

  test("records unknown error when a failed probe has empty stderr", async () => {
    const { collectSystemSnapshots } = await importSystemModule("unknown-failure");
    const runner: ProbeRunner = async () => ({
      ok: false,
      stdout: "",
      stderr: "",
    });

    const entries = await collectSystemSnapshots({
      projectRoot: "/tmp/project",
      groveDir: "/tmp/project/.grove",
      runner,
    });

    const processTree = decodeEntry(getEntry(entries, "system/process-tree.txt"));
    expect(processTree).toContain("Probe failed");
    expect(processTree).toContain("Command: ps -axo pid,ppid,comm,args");
    expect(processTree).toContain("unknown error");
  });

  test("default runner collects snapshots from successful child process probes", async () => {
    const commands: string[] = [];
    const execFileMock = mock((): void => {
      throw new Error("Expected promisified execFile path");
    });
    Object.defineProperty(execFileMock, promisify.custom, {
      value: async (
        file: string,
        args: readonly string[],
        _options: MockExecFileOptions,
      ): Promise<MockExecFileOutput> => {
        commands.push(`${file} ${args.join(" ")}`);
        return {
          stdout: `stdout for ${args.join(" ")}`,
          stderr: "",
        };
      },
    });
    mock.module("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { collectSystemSnapshots } = await importSystemModule("default-success");
    const entries = await collectSystemSnapshots({
      projectRoot: "/tmp/project",
      groveDir: "/tmp/project/.grove",
    });

    expect(commands).toEqual([
      "/bin/sh -lc ps -axo pid,ppid,comm,args",
      "/bin/sh -lc du -sh '/tmp/project/.grove' '/tmp/project'",
      "/bin/sh -lc lsof -nP | grep -E 'grove|bun|codex|claude|nexus' || true",
    ]);
    expect(entries.map((entry) => entry.path)).toEqual([
      "system/process-tree.txt",
      "system/disk-usage.txt",
      "system/open-fds.txt",
    ]);
    expect(decodeEntry(getEntry(entries, "system/process-tree.txt"))).toContain(
      "stdout for -lc ps -axo pid,ppid,comm,args",
    );
  });

  test("default runner configures a timeout and records timeout failures", async () => {
    let observedTimeout: number | undefined;
    const execFileMock = mock((): void => {
      throw new Error("Expected promisified execFile path");
    });
    Object.defineProperty(execFileMock, promisify.custom, {
      value: async (
        _file: string,
        _args: readonly string[],
        options: MockExecFileOptions,
      ): Promise<MockExecFileOutput> => {
        observedTimeout = options.timeout;
        const error = new Error("Command timed out after probe timeout");
        throw error;
      },
    });
    mock.module("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { collectSystemSnapshots } = await importSystemModule("default-timeout");
    const entries = await collectSystemSnapshots({
      projectRoot: "/tmp/project",
      groveDir: "/tmp/project/.grove",
    });

    expectTimeoutConfigured(observedTimeout);
    const processTree = decodeEntry(getEntry(entries, "system/process-tree.txt"));
    expect(processTree).toContain("Probe failed");
    expect(processTree).toContain("Command: ps -axo pid,ppid,comm,args");
    expect(processTree).toContain("timed out");
  });
});

interface SystemModule {
  readonly collectSystemSnapshots: (
    options: import("./system.js").SystemSnapshotOptions,
  ) => Promise<readonly DiagnosticEntry[]>;
}

interface MockExecFileOptions {
  readonly timeout?: number | undefined;
}

interface MockExecFileOutput {
  readonly stdout: string;
  readonly stderr: string;
}

async function importSystemModule(label: string): Promise<SystemModule> {
  return import(`./system.js?${label}`) as Promise<SystemModule>;
}

function expectTimeoutConfigured(timeout: number | undefined): void {
  if (timeout === undefined) {
    throw new Error("Expected default probe runner to configure a timeout");
  }
  expect(timeout).toBeGreaterThan(0);
}

function getEntry(entries: readonly DiagnosticEntry[], path: string): DiagnosticEntry {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) {
    throw new Error(`Expected diagnostic entry at ${path}`);
  }
  return entry;
}

function decodeEntry(entry: DiagnosticEntry): string {
  return new TextDecoder().decode(entry.bytes);
}
