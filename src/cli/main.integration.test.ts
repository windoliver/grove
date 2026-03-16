/**
 * E2E integration tests for the Grove CLI.
 *
 * Spawns the actual CLI binary to test the full dispatch pipeline:
 * argument parsing, store initialization, command execution, and exit codes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RelationType } from "../core/models.js";
import { makeContribution, makeRelation } from "../core/test-helpers.js";
import { FsCas } from "../local/fs-cas.js";
import { initSqliteDb, SqliteContributionStore } from "../local/sqlite-store.js";

const CLI_PATH = join(import.meta.dir, "main.ts");

/** Run the CLI with given args in a working directory and return stdout, stderr, exitCode. */
async function runCli(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

let tmpDir: string;
let groveDir: string;

/**
 * Set up a temp grove with a few contributions for testing.
 * Returns CIDs for optional use in tests.
 */
async function setupGrove(): Promise<{ c1Cid: string; c2Cid: string }> {
  groveDir = join(tmpDir, ".grove");
  await mkdir(groveDir, { recursive: true });

  const dbPath = join(groveDir, "grove.db");

  const db = initSqliteDb(dbPath);
  const store = new SqliteContributionStore(db);

  // Seed some contributions
  const c1 = makeContribution({
    summary: "Initial schema design",
    tags: ["schema"],
  });
  const c2 = makeContribution({
    summary: "Add validation layer",
    createdAt: "2026-01-02T00:00:00Z",
  });

  await store.put(c1);
  await store.put(c2);

  store.close();
  return { c1Cid: c1.cid, c2Cid: c2.cid };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-e2e-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Help and unknown commands
// ---------------------------------------------------------------------------

describe("CLI dispatch", () => {
  test("--help prints usage and exits 0", async () => {
    const { stdout, exitCode } = await runCli(["--help"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("grove");
    expect(stdout).toContain("checkout");
    expect(stdout).toContain("frontier");
  });

  test("-h prints usage", async () => {
    const { stdout, exitCode } = await runCli(["-h"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("grove");
  });

  // bare `grove` now launches the TUI (issue #113) instead of printing usage.
  // Not testable in CI (requires TTY for OpenTUI renderer).

  test("unknown command exits 2 (usage error)", async () => {
    const { stderr, exitCode } = await runCli(["bogus"], tmpDir);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown command");
  });

  test("--version prints version", async () => {
    const { stdout, exitCode } = await runCli(["--version"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("grove");
  });
});

// ---------------------------------------------------------------------------
// Commands that need a grove
// ---------------------------------------------------------------------------

describe("CLI commands (with grove)", () => {
  // -------------------------------------------------------------------------
  // grove log
  // -------------------------------------------------------------------------
  test("grove log works", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["log"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Initial schema");
  });

  test("grove log --json works", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["log", "--json"], tmpDir);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("results");
    expect(parsed).toHaveProperty("count");
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  test("grove log -n 1 returns newest only", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["log", "-n", "1"], tmpDir);
    expect(exitCode).toBe(0);
    // c2 (2026-01-02) is newest
    expect(stdout).toContain("Add validation layer");
    expect(stdout).not.toContain("Initial schema");
  });

  test("grove log --kind filters contributions", async () => {
    await setupGrove();
    // Both seeded are "work" kind, so --kind=review should show nothing
    const { stdout, exitCode } = await runCli(["log", "--kind", "review"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("(no results)");
  });

  // -------------------------------------------------------------------------
  // grove search
  // -------------------------------------------------------------------------
  test("grove search works", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["search", "--query", "schema"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("schema");
  });

  test("grove search --tag filters", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["search", "--tag", "schema"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Initial schema");
    expect(stdout).not.toContain("Add validation");
  });

  test("grove search --json works", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["search", "--json"], tmpDir);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("results");
    expect(parsed).toHaveProperty("count");
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBe(2);
  });

  test("grove search -n 1 --sort recency returns newest only", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["search", "-n", "1", "--sort", "recency"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Add validation");
    expect(stdout).not.toContain("Initial schema");
  });

  // -------------------------------------------------------------------------
  // grove frontier
  // -------------------------------------------------------------------------
  test("grove frontier works (empty is ok)", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["frontier"], tmpDir);
    expect(exitCode).toBe(0);
    // May show recency data or "no frontier data"
    expect(stdout.length).toBeGreaterThan(0);
  });

  test("grove frontier --json works", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["frontier", "--json"], tmpDir);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(typeof parsed).toBe("object");
  });

  // -------------------------------------------------------------------------
  // grove tree
  // -------------------------------------------------------------------------
  test("grove tree works", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["tree"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("*"); // DAG node marker
  });

  test("grove tree --json works", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["tree", "--json"], tmpDir);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("grove tree --from filters to subtree", async () => {
    groveDir = join(tmpDir, ".grove");
    await mkdir(groveDir, { recursive: true });
    const db = initSqliteDb(join(groveDir, "grove.db"));
    const store = new SqliteContributionStore(db);

    const root = makeContribution({ summary: "root-e2e" });
    const child = makeContribution({
      summary: "child-e2e",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
      createdAt: "2026-01-02T00:00:00Z",
    });
    const unrelated = makeContribution({
      summary: "unrelated-e2e",
      createdAt: "2026-01-03T00:00:00Z",
    });

    await store.put(root);
    await store.put(child);
    await store.put(unrelated);
    store.close();

    const { stdout, exitCode } = await runCli(["tree", "--from", child.cid], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("child-e2e");
    expect(stdout).toContain("root-e2e");
    expect(stdout).not.toContain("unrelated-e2e");
  });

  test("grove tree --depth limits traversal", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["tree", "--depth", "1"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("*");
  });

  // -------------------------------------------------------------------------
  // grove checkout
  // -------------------------------------------------------------------------
  test("grove checkout materializes artifacts to --to dir", async () => {
    groveDir = join(tmpDir, ".grove");
    await mkdir(groveDir, { recursive: true });
    const db = initSqliteDb(join(groveDir, "grove.db"));
    const store = new SqliteContributionStore(db);
    const cas = new FsCas(join(groveDir, "cas"));

    const data = new TextEncoder().encode("e2e artifact content");
    const hash = await cas.put(data);

    const c = makeContribution({
      summary: "checkout-e2e",
      artifacts: { "output.txt": hash },
    });
    await store.put(c);
    store.close();

    const outDir = join(tmpDir, "checkout-output");
    const { stdout, exitCode } = await runCli(["checkout", c.cid, "--to", outDir], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Checked out");
    expect(stdout).toContain(outDir);
    expect(stdout).toContain("checkout-e2e");
    expect(stdout).toContain("Artifacts: 1");

    // Verify the actual file was written
    const destFile = join(outDir, "output.txt");
    expect(existsSync(destFile)).toBe(true);
    const content = await readFile(destFile, "utf-8");
    expect(content).toBe("e2e artifact content");
  });

  test("grove checkout with nested artifacts", async () => {
    groveDir = join(tmpDir, ".grove");
    await mkdir(groveDir, { recursive: true });
    const db = initSqliteDb(join(groveDir, "grove.db"));
    const store = new SqliteContributionStore(db);
    const cas = new FsCas(join(groveDir, "cas"));

    const data = new TextEncoder().encode("nested e2e");
    const hash = await cas.put(data);

    const c = makeContribution({
      summary: "nested-checkout",
      artifacts: { "src/lib/main.py": hash },
    });
    await store.put(c);
    store.close();

    const outDir = join(tmpDir, "nested-out");
    const { exitCode } = await runCli(["checkout", c.cid, "--to", outDir], tmpDir);
    expect(exitCode).toBe(0);

    const destFile = join(outDir, "src", "lib", "main.py");
    expect(existsSync(destFile)).toBe(true);
    const content = await readFile(destFile, "utf-8");
    expect(content).toBe("nested e2e");
  });

  test("grove checkout fails for missing CID", async () => {
    await setupGrove();
    const badCid = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
    const { stderr, exitCode } = await runCli(
      ["checkout", badCid, "--to", join(tmpDir, "out")],
      tmpDir,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });

  test("grove checkout rejects missing --to", async () => {
    await setupGrove();
    const { stderr, exitCode } = await runCli(["checkout", "blake3:abc"], tmpDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--to");
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  test("fails gracefully outside a grove", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "grove-empty-"));
    try {
      const { stderr, exitCode } = await runCli(["log"], emptyDir);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Not inside a grove");
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// grove init --preset
// ---------------------------------------------------------------------------

describe("grove init --preset", () => {
  test("grove init --preset review-loop creates correct .grove/ structure", async () => {
    const { stdout, exitCode } = await runCli(
      ["init", "test-grove", "--preset", "review-loop"],
      tmpDir,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Initialized grove");
    expect(stdout).toContain("preset 'review-loop'");

    // Verify .grove directory exists
    expect(existsSync(join(tmpDir, ".grove"))).toBe(true);
    expect(existsSync(join(tmpDir, ".grove", "grove.db"))).toBe(true);
    expect(existsSync(join(tmpDir, ".grove", "cas"))).toBe(true);
    expect(existsSync(join(tmpDir, ".grove", "workspaces"))).toBe(true);
  });

  test("grove.json contains expected preset config", async () => {
    await runCli(["init", "test-grove", "--preset", "review-loop"], tmpDir);

    const configPath = join(tmpDir, ".grove", "grove.json");
    expect(existsSync(configPath)).toBe(true);

    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    expect(config.name).toBe("test-grove");
    expect(config.preset).toBe("review-loop");
    expect(config.mode).toBe("nexus");
    expect(config.nexusManaged).toBe(true);
    // nexusUrl is NOT written for managed Nexus — discovered at `grove up` time
    expect(config.nexusUrl).toBeUndefined();
    expect(config.services).toEqual({ server: true, mcp: false });
  });

  test("GROVE.md has expected topology for preset", async () => {
    await runCli(["init", "test-grove", "--preset", "review-loop"], tmpDir);

    const grovemdPath = join(tmpDir, "GROVE.md");
    expect(existsSync(grovemdPath)).toBe(true);

    const content = await readFile(grovemdPath, "utf-8");
    expect(content).toContain("contract_version: 3");
    expect(content).toContain("agent_topology:");
    expect(content).toContain("coder");
    expect(content).toContain("reviewer");
  });

  test("nexus-preferring preset uses managed Nexus without --nexus-url", async () => {
    const { stdout, exitCode } = await runCli(
      ["init", "test-grove", "--preset", "swarm-ops"],
      tmpDir,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Initialized grove");

    const raw = await readFile(join(tmpDir, ".grove", "grove.json"), "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    expect(config.mode).toBe("nexus");
    expect(config.nexusManaged).toBe(true);
    // nexusUrl is NOT written for managed Nexus — discovered at `grove up` time
    expect(config.nexusUrl).toBeUndefined();
  });

  test("nexus-preferring preset uses nexus with --nexus-url", async () => {
    const { stdout, exitCode } = await runCli(
      ["init", "test-grove", "--preset", "swarm-ops", "--nexus-url", "http://localhost:4000"],
      tmpDir,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Initialized grove");

    const raw = await readFile(join(tmpDir, ".grove", "grove.json"), "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    expect(config.mode).toBe("nexus");
    expect(config.nexusUrl).toBe("http://localhost:4000");
  });

  test("grove init --preset unknown fails with error", async () => {
    const { stderr, exitCode } = await runCli(
      ["init", "test-grove", "--preset", "nonexistent"],
      tmpDir,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown preset");
  });
});

// ---------------------------------------------------------------------------
// grove up / grove down (headless)
// ---------------------------------------------------------------------------

describe("grove up/down", () => {
  test("grove up --headless fails without grove.json", async () => {
    // Set up a bare grove without grove.json
    await setupGrove();
    const { stderr, exitCode } = await runCli(["up", "--headless"], tmpDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("grove.json");
  });

  test("grove down reports no services when PID file missing", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["down"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No running grove services");
  });
});
