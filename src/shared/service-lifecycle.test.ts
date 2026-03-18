/**
 * Tests for service lifecycle management (stopServices).
 *
 * startServices requires Bun.spawn and filesystem config, so we focus on
 * stopServices which accepts a RunningServices object and has testable
 * shutdown logic (SIGTERM → wait → SIGKILL).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunningServices } from "./service-lifecycle.js";
import { stopServices } from "./service-lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers — fake child process objects
// ---------------------------------------------------------------------------

function makeFakeChild(name: string, opts?: { hangOnExit?: boolean }) {
  const signals: string[] = [];
  let resolveExited: (code: number) => void;

  const exitedPromise = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  // If not hanging, resolve immediately after SIGTERM.
  // Always resolve on SIGKILL to avoid dangling promises.
  const proc = {
    pid: Math.floor(Math.random() * 90_000) + 10_000,
    kill(signal: string) {
      signals.push(signal);
      if (!opts?.hangOnExit && signal === "SIGTERM") {
        resolveExited!(0);
      }
      if (signal === "SIGKILL") {
        resolveExited!(137);
      }
    },
    get exited() {
      return exitedPromise;
    },
  };

  return {
    child: { name, pid: proc.pid, proc } as unknown as RunningServices["children"][number],
    signals,
    forceExit: () => resolveExited!(1),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stopServices", () => {
  let tempDir: string;

  afterEach(() => {
    // Clean up temp dirs (best-effort)
    try {
      const { rmSync } = require("node:fs") as typeof import("node:fs");
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("sends SIGTERM and waits for graceful exit", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-test-"));
    const pidFile = join(tempDir, "grove.pid");
    writeFileSync(pidFile, "{}");

    const { child, signals } = makeFakeChild("server");

    const services: RunningServices = {
      children: [child],
      nexusManaged: false,
      projectRoot: tempDir,
      pidFilePath: pidFile,
    };

    await stopServices(services);

    expect(signals).toContain("SIGTERM");
    // Should NOT have needed SIGKILL since our fake exits immediately
    expect(signals).not.toContain("SIGKILL");
    // PID file should be cleaned up
    expect(existsSync(pidFile)).toBe(false);
  });

  test("sends SIGKILL when child does not exit within timeout", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-test-"));
    const pidFile = join(tempDir, "grove.pid");
    writeFileSync(pidFile, "{}");

    const { child, signals } = makeFakeChild("hung-server", { hangOnExit: true });

    const services: RunningServices = {
      children: [child],
      nexusManaged: false,
      projectRoot: tempDir,
      pidFilePath: pidFile,
    };

    // stopServices has a 5s deadline but our fake never resolves on SIGTERM,
    // so it should escalate to SIGKILL after timeout
    await stopServices(services);

    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
  }, 10_000);

  test("handles empty children list without error", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-test-"));
    const pidFile = join(tempDir, "grove.pid");

    const services: RunningServices = {
      children: [],
      nexusManaged: false,
      projectRoot: tempDir,
      pidFilePath: pidFile,
    };

    // Should not throw
    await stopServices(services);
  });

  test("tolerates kill throwing (process already dead)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-test-"));
    const pidFile = join(tempDir, "grove.pid");

    const proc = {
      pid: 99999,
      kill() {
        throw new Error("No such process");
      },
      exited: Promise.resolve(0),
    };

    const services: RunningServices = {
      children: [
        { name: "dead-server", pid: 99999, proc } as unknown as RunningServices["children"][number],
      ],
      nexusManaged: false,
      projectRoot: tempDir,
      pidFilePath: pidFile,
    };

    // Should not throw even though kill() throws
    await stopServices(services);
  });
});
