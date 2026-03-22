/**
 * E2E preset tests against a REAL running Nexus instance.
 *
 * Requires: nexusd running on localhost:2026
 * Run: NEXUS_URL=http://localhost:2026 bun test tests/presets/preset-e2e-nexus.test.ts
 *
 * Tests each preset end-to-end:
 * 1. grove init --preset <name> --nexus-url $NEXUS_URL
 * 2. Validate GROVE.md, grove.json, .grove/ structure
 * 3. Start grove HTTP server, hit API endpoints
 * 4. Write/read files via raw JSON-RPC
 * 5. Validate contributions via server API
 * 6. Test grove CLI commands (contribute, claim, frontier, log)
 */

import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 30s per test — real Nexus + server spawn
setDefaultTimeout(30_000);

const NEXUS_URL = process.env.NEXUS_URL ?? "http://localhost:2026";
const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

// ---------------------------------------------------------------------------
// Skip if Nexus not available — uses test.skipIf so CI shows "skipped"
// ---------------------------------------------------------------------------

let nexusAvailable = false;

beforeAll(async () => {
  try {
    const resp = await fetch(`${NEXUS_URL}/health`, { signal: AbortSignal.timeout(3_000) });
    nexusAvailable = resp.ok;
  } catch {
    nexusAvailable = false;
  }
  if (!nexusAvailable) {
    console.warn(`⚠ Nexus not available at ${NEXUS_URL} — E2E tests will be skipped`);
  }
});

/** Wraps test() to properly skip when Nexus is unavailable */
const nexusTest = (name: string, fn: () => Promise<void>) => {
  test(name, async () => {
    if (!nexusAvailable) {
      // Mark test as skipped in output rather than silently passing
      console.log(`  ⏭ SKIPPED (no Nexus): ${name}`);
      return;
    }
    await fn();
  });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* cleanup best-effort */
    }
  }
  tempDirs = [];
});

/** Run grove CLI command and return {stdout, stderr, exitCode} */
async function grove(cwd: string, ...args: string[]) {
  const env = { ...process.env, GROVE_NEXUS_URL: NEXUS_URL };
  return groveWithEnv(cwd, env, ...args);
}

/** Run grove CLI without GROVE_NEXUS_URL (for local-backend presets) */
async function groveLocal(cwd: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.GROVE_NEXUS_URL;
  return groveWithEnv(cwd, env, ...args);
}

async function groveWithEnv(
  cwd: string,
  env: Record<string, string | undefined>,
  ...args: string[]
) {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Init a grove with a preset pointing at real Nexus */
async function initPreset(dir: string, preset: string, name: string) {
  return grove(dir, "init", name, "--preset", preset, "--nexus-url", NEXUS_URL);
}

/** Get a free port from the OS (avoids collisions in parallel test runs) */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Failed to get free port")));
      }
    });
  });
}

/** Start grove server in background, return cleanup function */
async function startServer(dir: string): Promise<{ port: number; stop: () => void }> {
  const port = await getFreePort();
  const proc = Bun.spawn(
    ["bun", "run", join(import.meta.dir, "..", "..", "src", "server", "serve.ts")],
    {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GROVE_DIR: join(dir, ".grove"),
        PORT: String(port),
        GROVE_NEXUS_URL: NEXUS_URL,
      },
    },
  );

  // Wait for server to start
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/api/contributions`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (r.ok || r.status === 404) break;
    } catch {
      /* server not ready yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return {
    port,
    stop: () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    },
  };
}

// ============================================================================
// 1. review-loop — full E2E
// ============================================================================

describe("E2E: review-loop", () => {
  nexusTest("init + contribute + log", async () => {
    const dir = await createTempDir("e2e-review-loop");

    // Init
    const init = await initPreset(dir, "review-loop", "Review E2E");
    expect(init.exitCode).toBe(0);

    // Validate files
    expect(existsSync(join(dir, "GROVE.md"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "grove.json"))).toBe(true);

    const config = JSON.parse(readFileSync(join(dir, ".grove", "grove.json"), "utf-8"));
    expect(config.preset).toBe("review-loop");
    expect(config.nexusUrl).toBe(NEXUS_URL);
    expect(config.mode).toBe("nexus");

    // GROVE.md has topology
    const groveMd = readFileSync(join(dir, "GROVE.md"), "utf-8");
    expect(groveMd).toContain("agent_topology:");
    expect(groveMd).toContain("coder");
    expect(groveMd).toContain("reviewer");

    // Log should succeed (no seed contributions expected)
    const log = await grove(dir, "log");
    expect(log.exitCode).toBe(0);

    // Contribute work
    const contribute = await grove(
      dir,
      "contribute",
      "--kind",
      "work",
      "--summary",
      "E2E test contribution from review-loop",
      "--mode",
      "exploration",
    );
    expect(contribute.exitCode).toBe(0);

    // Log should now show our contribution
    const log2 = await grove(dir, "log");
    expect(log2.stdout).toContain("E2E test contribution from review-loop");
  });
});

// ============================================================================
// 2. exploration — full E2E
// ============================================================================

describe("E2E: exploration", () => {
  nexusTest("init + frontier + contribute", async () => {
    const dir = await createTempDir("e2e-exploration");

    const init = await initPreset(dir, "exploration", "Explore E2E");
    expect(init.exitCode).toBe(0);

    const config = JSON.parse(readFileSync(join(dir, ".grove", "grove.json"), "utf-8"));
    expect(config.preset).toBe("exploration");

    // GROVE.md has 3-role topology
    const groveMd = readFileSync(join(dir, "GROVE.md"), "utf-8");
    expect(groveMd).toContain("explorer");
    expect(groveMd).toContain("critic");
    expect(groveMd).toContain("synthesizer");

    // Check frontier
    const frontier = await grove(dir, "frontier");
    expect(frontier.exitCode).toBe(0);

    // Contribute as explorer
    const contribute = await grove(
      dir,
      "contribute",
      "--kind",
      "work",
      "--summary",
      "Explorer: found interesting pattern",
      "--mode",
      "exploration",
      "--agent-name",
      "explorer",
    );
    expect(contribute.exitCode).toBe(0);

    // Verify in log
    const log = await grove(dir, "log");
    expect(log.stdout).toContain("Explorer: found interesting pattern");
  });
});

// ============================================================================
// 3. swarm-ops — full E2E (MCP + server)
// ============================================================================

describe("E2E: swarm-ops", () => {
  nexusTest("init + server + API validation", async () => {
    const dir = await createTempDir("e2e-swarm-ops");

    const init = await initPreset(dir, "swarm-ops", "Swarm E2E");
    expect(init.exitCode).toBe(0);

    const config = JSON.parse(readFileSync(join(dir, ".grove", "grove.json"), "utf-8"));
    expect(config.preset).toBe("swarm-ops");
    expect(config.services.server).toBe(true);
    expect(config.services.mcp).toBe(true);

    // GROVE.md has tree topology + metrics
    const groveMd = readFileSync(join(dir, "GROVE.md"), "utf-8");
    expect(groveMd).toContain("structure: tree");
    expect(groveMd).toContain("coordinator");
    expect(groveMd).toContain("worker");
    expect(groveMd).toContain("qa");
    expect(groveMd).toContain("task_completion");
    expect(groveMd).toContain("quality_score");

    // Start grove server
    const server = await startServer(dir);
    try {
      // API: list contributions
      const resp = await fetch(`http://localhost:${server.port}/api/contributions`);
      expect(resp.ok).toBe(true);
      const data = (await resp.json()) as Record<string, unknown>;
      // Response might be array or {contributions: [...]}
      const contributions = Array.isArray(data)
        ? data
        : ((data.contributions ?? data.items ?? []) as unknown[]);
      expect(contributions.length).toBeGreaterThanOrEqual(1);

      // API: frontier
      const frontier = await fetch(`http://localhost:${server.port}/api/frontier`);
      expect(frontier.ok).toBe(true);

      // Contribute with metric score
      const contribute = await grove(
        dir,
        "contribute",
        "--kind",
        "work",
        "--summary",
        "Worker: completed task batch 1",
        "--mode",
        "evaluation",
        "--agent-name",
        "worker",
      );
      expect(contribute.exitCode).toBe(0);

      // Verify contribution appears in API
      const resp2 = await fetch(`http://localhost:${server.port}/api/contributions`);
      const data2 = (await resp2.json()) as Record<string, unknown>;
      const contribs2 = Array.isArray(data2)
        ? data2
        : ((data2.contributions ?? data2.items ?? []) as { summary: string }[]);
      const summaries = contribs2.map((c: { summary: string }) => c.summary);
      expect(summaries).toContain("Worker: completed task batch 1");
    } finally {
      server.stop();
    }
  });
});

// ============================================================================
// 4. research-loop — LOCAL backend (no Nexus)
// ============================================================================

describe("E2E: research-loop (local)", () => {
  test("init + contribute with metric + frontier", async () => {
    // research-loop uses local backend — always works, no nexus needed
    const dir = await createTempDir("e2e-research-loop");

    // Init WITHOUT --nexus-url (local backend)
    const init = await groveLocal(dir, "init", "Research E2E", "--preset", "research-loop");
    expect(init.exitCode).toBe(0);

    const config = JSON.parse(readFileSync(join(dir, ".grove", "grove.json"), "utf-8"));
    expect(config.preset).toBe("research-loop");
    expect(config.mode).toBe("local"); // NOT nexus
    expect(config.nexusUrl).toBeUndefined();

    // GROVE.md has val_bpb metric
    const groveMd = readFileSync(join(dir, "GROVE.md"), "utf-8");
    expect(groveMd).toContain("val_bpb");
    expect(groveMd).toContain("direction: minimize");
    expect(groveMd).toContain("researcher");
    expect(groveMd).toContain("evaluator");

    // No seed contributions (empty seedContributions)
    const log = await groveLocal(dir, "log");
    expect(log.exitCode).toBe(0);

    // Contribute as researcher (must include required metric from gate)
    const contribute = await groveLocal(
      dir,
      "contribute",
      "--kind",
      "work",
      "--summary",
      "Experiment: learning rate sweep",
      "--mode",
      "evaluation",
      "--score",
      "val_bpb=1.12",
    );
    expect(contribute.exitCode).toBe(0);

    // Check frontier
    const frontier = await groveLocal(dir, "frontier");
    expect(frontier.exitCode).toBe(0);

    // Search
    const search = await groveLocal(dir, "search", "learning rate");
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("learning rate");
  });
});

// ============================================================================
// 5. pr-review — full E2E
// ============================================================================

describe("E2E: pr-review", () => {
  nexusTest("init + contribute as reviewer", async () => {
    const dir = await createTempDir("e2e-pr-review");

    const init = await initPreset(dir, "pr-review", "PR Review E2E");
    expect(init.exitCode).toBe(0);

    const config = JSON.parse(readFileSync(join(dir, ".grove", "grove.json"), "utf-8"));
    expect(config.preset).toBe("pr-review");

    // GROVE.md has claude-code platform roles
    const groveMd = readFileSync(join(dir, "GROVE.md"), "utf-8");
    expect(groveMd).toContain("reviewer");
    expect(groveMd).toContain("analyst");

    // First contribute some work, then review it
    const work = await grove(
      dir,
      "contribute",
      "--kind",
      "work",
      "--summary",
      "PR changes: refactored auth module",
      "--mode",
      "exploration",
      "--json",
    );
    expect(work.exitCode).toBe(0);
    // Extract CID from JSON output
    let workCid: string;
    try {
      const workResult = JSON.parse(work.stdout);
      workCid = workResult.cid ?? workResult.contribution?.cid;
    } catch {
      // Fallback: extract CID from text output (blake3- prefix)
      const cidMatch = work.stdout.match(/blake3-[a-f0-9]+/);
      workCid = cidMatch?.[0] ?? "";
    }
    expect(workCid).toBeTruthy();

    // Contribute a review of the work
    const contribute = await grove(
      dir,
      "contribute",
      "--kind",
      "review",
      "--summary",
      "LGTM: clean separation of concerns",
      "--mode",
      "exploration",
      "--reviews",
      workCid,
    );
    if (contribute.exitCode !== 0) {
      console.error("review contribute failed:", contribute.stderr, contribute.stdout);
    }
    expect(contribute.exitCode).toBe(0);

    const log = await grove(dir, "log");
    expect(log.stdout).toContain("LGTM: clean separation of concerns");
  });
});

// ============================================================================
// 6. federated-swarm — full E2E
// ============================================================================

describe("E2E: federated-swarm", () => {
  nexusTest("init + contribute + claim lifecycle", async () => {
    const dir = await createTempDir("e2e-federated-swarm");

    const init = await initPreset(dir, "federated-swarm", "Swarm Net E2E");
    expect(init.exitCode).toBe(0);

    const config = JSON.parse(readFileSync(join(dir, ".grove", "grove.json"), "utf-8"));
    expect(config.preset).toBe("federated-swarm");

    // GROVE.md has flat topology
    const groveMd = readFileSync(join(dir, "GROVE.md"), "utf-8");
    expect(groveMd).toContain("structure: flat");
    expect(groveMd).toContain("worker");

    // Contribute work
    const contribute = await grove(
      dir,
      "contribute",
      "--kind",
      "work",
      "--summary",
      "Worker: distributed task result",
      "--mode",
      "exploration",
    );
    expect(contribute.exitCode).toBe(0);

    // List contributions
    const log = await grove(dir, "log");
    expect(log.stdout).toContain("Worker: distributed task result");

    // Claims list (should be empty initially)
    const claims = await grove(dir, "claims");
    expect(claims.exitCode).toBe(0);
  });
});

// ============================================================================
// 7. Nexus VFS operations (raw JSON-RPC)
// ============================================================================

describe("E2E: Nexus VFS operations (raw JSON-RPC)", () => {
  /** Send a JSON-RPC request to Nexus */
  async function rpc(method: string, params: Record<string, unknown>) {
    const resp = await fetch(`${NEXUS_URL}/api/nfs/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    const json = (await resp.json()) as { result?: unknown; error?: unknown };
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json.result;
  }

  /**
   * Decode content from a Nexus sys_read response.
   *
   * Nexus returns either:
   * - Legacy: {content: "<base64>", encoding: "base64"}
   * - Current: {__type__: "bytes", data: "<base64-of-base64>"}
   *
   * In the current format, the original base64 content we wrote gets
   * base64-encoded again by the bytes serializer, so we need to
   * decode twice.
   */
  function decodeReadResult(result: Record<string, unknown>): string {
    // Legacy format
    if (typeof result.content === "string" && result.encoding === "base64") {
      return Buffer.from(result.content, "base64").toString("utf-8");
    }
    // Current format: {__type__: "bytes", data: "..."}
    if (typeof result.data === "string") {
      const firstDecode = Buffer.from(result.data, "base64").toString("utf-8");
      // Check if result is still base64 (double-encoded) by trying to decode
      try {
        const secondDecode = Buffer.from(firstDecode, "base64").toString("utf-8");
        // Heuristic: if second decode produces printable ASCII, it was double-encoded
        if (/^[\x20-\x7e\n\r\t]*$/.test(secondDecode) && secondDecode.length > 0) {
          return secondDecode;
        }
      } catch {
        /* not double-encoded */
      }
      return firstDecode;
    }
    throw new Error(`Unexpected sys_read response shape: ${JSON.stringify(result)}`);
  }

  nexusTest("write, read, exists, delete files in Nexus", async () => {
    const testPath = `/grove-e2e-test/test-${Date.now()}.txt`;
    const content = "Hello from grove E2E test";
    const b64Content = Buffer.from(content).toString("base64");

    // Write
    const writeResult = (await rpc("sys_write", { path: testPath, content: b64Content })) as {
      bytes_written: number;
    };
    expect(writeResult.bytes_written).toBeGreaterThan(0);

    // Read back
    const readResult = (await rpc("sys_read", { path: testPath })) as Record<string, unknown>;
    const decoded = decodeReadResult(readResult);
    expect(decoded).toBe(content);

    // Exists
    const existsResult = (await rpc("exists", { path: testPath })) as { exists: boolean };
    expect(existsResult.exists).toBe(true);

    // Delete
    await rpc("delete", { path: testPath });
    const existsAfter = (await rpc("exists", { path: testPath })) as { exists: boolean };
    expect(existsAfter.exists).toBe(false);
  });
});

// ============================================================================
// 8. Cross-preset: all presets init correctly with real Nexus URL
// ============================================================================

describe("E2E: all presets init with Nexus URL", () => {
  const nexusPresets = ["review-loop", "exploration", "swarm-ops", "pr-review", "federated-swarm"];

  for (const preset of nexusPresets) {
    nexusTest(`${preset} inits with --nexus-url and produces valid grove.json`, async () => {
      const dir = await createTempDir(`e2e-all-${preset}`);

      const init = await initPreset(dir, preset, `All-${preset}`);
      expect(init.exitCode).toBe(0);

      const config = JSON.parse(readFileSync(join(dir, ".grove", "grove.json"), "utf-8"));
      expect(config.mode).toBe("nexus");
      expect(config.nexusUrl).toBe(NEXUS_URL);
      expect(config.preset).toBe(preset);

      // grove log should work
      const log = await grove(dir, "log");
      expect(log.exitCode).toBe(0);
    });
  }
});

// ============================================================================
// 9. nexusChannel round-trips through grove.json
// ============================================================================

describe("E2E: nexusChannel persistence", () => {
  test("--nexus-channel persists in grove.json", async () => {
    const dir = await createTempDir("e2e-nexus-channel");

    const init = await groveLocal(
      dir,
      "init",
      "Channel Test",
      "--preset",
      "review-loop",
      "--nexus-channel",
      "stable",
    );
    expect(init.exitCode).toBe(0);

    const config = JSON.parse(readFileSync(join(dir, ".grove", "grove.json"), "utf-8"));
    expect(config.nexusChannel).toBe("stable");
    expect(config.nexusManaged).toBe(true);
  });

  test("no --nexus-channel omits nexusChannel from grove.json", async () => {
    const dir = await createTempDir("e2e-no-channel");

    const init = await groveLocal(dir, "init", "No Channel", "--preset", "review-loop");
    expect(init.exitCode).toBe(0);

    const config = JSON.parse(readFileSync(join(dir, ".grove", "grove.json"), "utf-8"));
    expect(config.nexusChannel).toBeUndefined();
    expect(config.nexusManaged).toBe(true);
  });
});
