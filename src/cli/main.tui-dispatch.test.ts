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
    // When invoked without a TTY, handleTuiDirect may block or fail to
    // render. The key assertion: it should NOT exit with code 2
    // ("unknown command"). We give it 5s then kill it — if it hasn't
    // exited with code 2 by then, it successfully reached the TUI path.
    //
    // stdout is "ignore" because the TUI emits a continuous stream of
    // ANSI escape codes; if we piped it without draining, the child's
    // stdout buffer would fill in <1s, the TUI would block on write,
    // and SIGTERM cleanup would hang past the outer test timeout.
    const proc = Bun.spawn(["bun", "run", CLI_PATH], {
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, TERM: "dumb" },
    });

    // Race: either the process exits on its own, or we kill after 5s.
    // Bun's cold-start on larger entry points (grove main.ts pulls in a
    // lot of TS) routinely takes >2s on a warm machine, so the old 2s
    // timeout would fire before the process had a chance to exit-on-its-
    // -own, and the subsequent `await proc.exited` would then hit the
    // outer bun:test 5s timeout.
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000));
    const result = await Promise.race([
      proc.exited.then((code) => ({ kind: "exited" as const, code })),
      timeout.then((t) => ({ kind: t })),
    ]);

    if (result.kind === "timeout") {
      // Process is still running (TUI is blocking) — this means it
      // successfully dispatched to handleTuiDirect and didn't exit with
      // "unknown command". SIGTERM first; SIGKILL after a grace period
      // in case the TUI traps the signal and stalls in cleanup.
      proc.kill();
      const killTimer = setTimeout(() => proc.kill("SIGKILL"), 2000);
      await proc.exited;
      clearTimeout(killTimer);
    } else {
      // Process exited — verify it wasn't a usage error
      const stderr = await new Response(proc.stderr).text();
      expect(result.code).not.toBe(2);
      expect(stderr).not.toContain("unknown command");
    }
  }, 15_000); // Outer test timeout must exceed the inner 5s kill deadline.

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
