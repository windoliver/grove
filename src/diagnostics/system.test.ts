import { describe, expect, test } from "bun:test";
import type { DiagnosticEntry } from "./sqlite-export.js";
import type { ProbeExecFile, ProbeRunner } from "./system.js";

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
    const { collectSystemSnapshots, createProbeRunner } =
      await importSystemModule("default-success");
    const commands: string[] = [];
    const execFileMock: ProbeExecFile = async (file, args) => {
      commands.push(`${file} ${args.join(" ")}`);
      return {
        stdout: `stdout for ${args.join(" ")}`,
        stderr: "",
      };
    };
    const entries = await collectSystemSnapshots({
      projectRoot: "/tmp/project",
      groveDir: "/tmp/project/.grove",
      runner: createProbeRunner(execFileMock),
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
    const { collectSystemSnapshots, createProbeRunner } =
      await importSystemModule("default-timeout");
    let observedTimeout: number | undefined;
    const execFileMock: ProbeExecFile = async (_file, _args, options) => {
      observedTimeout = options.timeout;
      const error = new Error("Command timed out after probe timeout");
      Object.assign(error, {
        stderr: "",
        killed: true,
        signal: "SIGTERM",
      });
      throw error;
    };
    const entries = await collectSystemSnapshots({
      projectRoot: "/tmp/project",
      groveDir: "/tmp/project/.grove",
      runner: createProbeRunner(execFileMock),
    });

    expectTimeoutConfigured(observedTimeout);
    const processTree = decodeEntry(getEntry(entries, "system/process-tree.txt"));
    expect(processTree).toContain("Probe failed");
    expect(processTree).toContain("Command: ps -axo pid,ppid,comm,args");
    expect(processTree).toContain("timed out");
    expect(processTree).not.toContain("unknown error");
  });
});

interface SystemModule {
  readonly collectSystemSnapshots: (
    options: import("./system.js").SystemSnapshotOptions,
  ) => Promise<readonly DiagnosticEntry[]>;
  readonly createProbeRunner: (execFileAsync: ProbeExecFile) => ProbeRunner;
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
