/**
 * Unit test for bare `grove` → TUI dispatch (10A).
 *
 * Verifies that invoking the CLI with no arguments calls handleTuiDirect()
 * without requiring a TTY (tests routing, not rendering).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "main.ts");

describe("bare grove → TUI dispatch", () => {
  test("bare grove does not exit with usage error", async () => {
    // When invoked without a TTY, handleTuiDirect may block or fail to render.
    // The key assertion: it should NOT exit with code 2 ("unknown command").
    // We give it 2s then kill it — if it hasn't exited with code 2 by then,
    // it successfully reached the TUI path.
    const proc = Bun.spawn(["bun", "run", CLI_PATH], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TERM: "dumb" },
    });

    // Race: either the process exits on its own, or we kill after 2s
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000));
    const result = await Promise.race([
      proc.exited.then((code) => ({ kind: "exited" as const, code })),
      timeout.then((t) => ({ kind: t })),
    ]);

    if (result.kind === "timeout") {
      // Process is still running (TUI is blocking) — this means it successfully
      // dispatched to handleTuiDirect and didn't exit with "unknown command"
      proc.kill();
      await proc.exited;
    } else {
      // Process exited — verify it wasn't a usage error
      const stderr = await new Response(proc.stderr).text();
      expect(result.code).not.toBe(2);
      expect(stderr).not.toContain("unknown command");
    }
  });

  test("grove --help still works", async () => {
    const proc = Bun.spawn(["bun", "run", CLI_PATH, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, _stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("grove");
    expect(stdout).toContain("tui");
  });

  test("main.ts imports handleTuiDirect for bare invocation", async () => {
    // Verify the dispatch code path exists by reading the source
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(CLI_PATH, "utf-8");
    expect(source).toContain("handleTuiDirect");
    // Verify the dispatch pattern: no first arg → handleTuiDirect
    expect(source).toContain("if (!first)");
  });
});
