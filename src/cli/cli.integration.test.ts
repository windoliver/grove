/**
 * End-to-end integration tests for the grove CLI.
 *
 * Spawns the actual CLI binary and asserts on stdout/stderr/exit code.
 * These are thin smoke tests — detailed behavior is tested in command handler tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("grove CLI integration", () => {
  let tempDir: string;
  let groveDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-cli-int-"));
    groveDir = join(tempDir, ".grove");
    await mkdir(groveDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function extractClaimId(stdout: string): string {
    const match = stdout.match(/(?:Claimed|Renewed): (.+)/);
    if (!match?.[1]) throw new Error(`Could not extract claim ID from output: ${stdout}`);
    return match[1].trim();
  }

  async function runGrove(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "main.ts"), "--grove", groveDir, ...args],
      {
        cwd: tempDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GROVE_AGENT_ID: "test-agent" },
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  test("grove --help shows usage", async () => {
    const { stdout, exitCode } = await runGrove(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("grove");
    expect(stdout).toContain("claim");
    expect(stdout).toContain("release");
  });

  test("grove --version shows version", async () => {
    const { stdout, exitCode } = await runGrove(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("grove 0.1.0");
  });

  test("grove claim + release round-trip", async () => {
    // Create a claim
    const claimResult = await runGrove(["claim", "my-target", "--lease", "30m"]);
    expect(claimResult.exitCode).toBe(0);
    expect(claimResult.stdout).toContain("Claimed");
    expect(claimResult.stdout).toContain("my-target");

    // Extract claim ID from output
    const claimId = extractClaimId(claimResult.stdout);

    // List claims — should show the active claim
    const listResult = await runGrove(["claims"]);
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("my-target");

    // Release the claim
    const releaseResult = await runGrove(["release", claimId]);
    expect(releaseResult.exitCode).toBe(0);
    expect(releaseResult.stdout).toContain("Released");

    // List claims — should be empty now (released claims don't show by default)
    const listAfter = await runGrove(["claims"]);
    expect(listAfter.exitCode).toBe(0);
    expect(listAfter.stdout).toContain("No claims found");

    // List with --expired should show the released claim
    const expiredResult = await runGrove(["claims", "--expired"]);
    expect(expiredResult.exitCode).toBe(0);
    expect(expiredResult.stdout).toContain("my-target");
  });

  test("grove release --completed marks claim as completed", async () => {
    const claimResult = await runGrove(["claim", "complete-target", "--lease", "1h"]);
    expect(claimResult.exitCode).toBe(0);
    const claimId = extractClaimId(claimResult.stdout);

    const completeResult = await runGrove(["release", claimId, "--completed"]);
    expect(completeResult.exitCode).toBe(0);
    expect(completeResult.stdout).toContain("Completed");
  });

  test("grove claim renews lease for same agent", async () => {
    const first = await runGrove(["claim", "renew-target", "--lease", "30m"]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Claimed");

    // Same agent reclaims — should renew
    const second = await runGrove(["claim", "renew-target", "--lease", "1h"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Renewed");
  });

  test("grove claims shows full claim ID usable by grove release", async () => {
    const claimResult = await runGrove(["claim", "id-test", "--lease", "1h"]);
    const claimId = extractClaimId(claimResult.stdout);

    // The full claim ID should appear in the listing
    const listResult = await runGrove(["claims"]);
    expect(listResult.stdout).toContain(claimId);

    // And it should be usable in grove release
    const releaseResult = await runGrove(["release", claimId]);
    expect(releaseResult.exitCode).toBe(0);
  });

  test("grove frontier --context accepts valid JSON and returns results", async () => {
    const result = await runGrove(["frontier", "--context", '{"hardware":"H100"}', "--json"]);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    // Empty grove, but the flag was accepted and parsed
    expect(data.byRecency).toEqual([]);
    expect(data.byMetric).toEqual({});
  });

  test("grove frontier --context rejects invalid JSON", async () => {
    const result = await runGrove(["frontier", "--context", "not-json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --context");
  });

  test("grove discuss + thread round-trip", async () => {
    // This test needs a fully initialized grove. Use a separate temp dir
    // and run without --grove so init creates .grove itself.
    const discDir = await mkdtemp(join(tmpdir(), "grove-discuss-int-"));
    try {
      async function runDiscGrove(
        args: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        const proc = Bun.spawn(["bun", join(import.meta.dir, "main.ts"), ...args], {
          cwd: discDir,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, GROVE_AGENT_ID: "test-agent" },
        });
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      }

      // Init the grove
      const initResult = await runDiscGrove(["init", "test-grove"]);
      expect(initResult.exitCode).toBe(0);

      // Post a root discussion
      const discussResult = await runDiscGrove(["discuss", "Should we refactor the parser?"]);
      expect(discussResult.exitCode).toBe(0);
      expect(discussResult.stdout).toContain("blake3:");

      // Extract CID
      const cidMatch = discussResult.stdout.match(/blake3:[a-f0-9]+/);
      expect(cidMatch).not.toBeNull();
      const rootCid = cidMatch?.[0] ?? "";

      // Reply to it
      const replyResult = await runDiscGrove(["discuss", rootCid, "Yes, it is too complex"]);
      expect(replyResult.exitCode).toBe(0);

      // View thread
      const threadResult = await runDiscGrove(["thread", rootCid]);
      expect(threadResult.exitCode).toBe(0);
      expect(threadResult.stdout).toContain("Should we refactor the parser?");
      expect(threadResult.stdout).toContain("Yes, it is too complex");

      // List threads
      const threadsResult = await runDiscGrove(["threads"]);
      expect(threadsResult.exitCode).toBe(0);
      expect(threadsResult.stdout).toContain("Should we refactor the parser?");
    } finally {
      await rm(discDir, { recursive: true, force: true });
    }
  });

  test("grove unknown-command shows error", async () => {
    const { stderr, exitCode } = await runGrove(["nonexistent"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command");
  });

  test("grove claim without target shows usage error", async () => {
    const { stderr, exitCode } = await runGrove(["claim"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("target is required");
  });
});
