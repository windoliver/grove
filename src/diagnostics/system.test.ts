import { describe, expect, test } from "bun:test";
import type { DiagnosticEntry } from "./sqlite-export.js";
import type { ProbeRunner } from "./system.js";
import { collectSystemSnapshots } from "./system.js";

describe("collectSystemSnapshots", () => {
  test("collects system probes in a stable order", async () => {
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
});

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
