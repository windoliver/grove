/**
 * Tests for `grove contribute` command.
 *
 * Covers argument parsing, validation, execution logic, and edge cases.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContributeOptions } from "./contribute.js";
import { executeContribute, parseContributeArgs, validateContributeOptions } from "./contribute.js";
import type { InitOptions } from "./init.js";
import { executeInit } from "./init.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-contribute-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeInitOptions(cwd: string): InitOptions {
  return {
    name: "test-grove",
    mode: "evaluation",
    seed: [],
    metric: [],
    force: false,
    agentOverrides: { agentId: "test-agent" },
    cwd,
  };
}

function makeContributeOptions(overrides?: Partial<ContributeOptions>): ContributeOptions {
  return {
    kind: "work",
    mode: "evaluation",
    summary: "Test contribution",
    artifacts: [],
    fromGitTree: false,
    metric: [],
    score: [],
    tags: [],
    agentOverrides: { agentId: "test-agent" },
    cwd: "/tmp/test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseContributeArgs
// ---------------------------------------------------------------------------

describe("parseContributeArgs", () => {
  test("parses --summary flag", () => {
    const opts = parseContributeArgs(["--summary", "My contribution"]);
    expect(opts.summary).toBe("My contribution");
  });

  test("parses --kind flag", () => {
    const opts = parseContributeArgs(["--kind", "review", "--summary", "test"]);
    expect(opts.kind).toBe("review");
  });

  test("defaults kind to work", () => {
    const opts = parseContributeArgs(["--summary", "test"]);
    expect(opts.kind).toBe("work");
  });

  test("mode is undefined when --mode is omitted", () => {
    const opts = parseContributeArgs(["--summary", "test"]);
    expect(opts.mode).toBeUndefined();
  });

  test("parses --mode flag", () => {
    const opts = parseContributeArgs(["--summary", "test", "--mode", "exploration"]);
    expect(opts.mode).toBe("exploration");
  });

  test("parses multiple --artifacts flags", () => {
    const opts = parseContributeArgs([
      "--summary",
      "test",
      "--artifacts",
      "./src",
      "--artifacts",
      "./tests",
    ]);
    expect(opts.artifacts).toEqual(["./src", "./tests"]);
  });

  test("parses --from-git-diff flag", () => {
    const opts = parseContributeArgs(["--summary", "test", "--from-git-diff", "HEAD~1"]);
    expect(opts.fromGitDiff).toBe("HEAD~1");
  });

  test("parses --from-git-tree flag", () => {
    const opts = parseContributeArgs(["--summary", "test", "--from-git-tree"]);
    expect(opts.fromGitTree).toBe(true);
  });

  test("parses --from-report flag", () => {
    const opts = parseContributeArgs(["--summary", "test", "--from-report", "./analysis.md"]);
    expect(opts.fromReport).toBe("./analysis.md");
  });

  test("parses relation flags", () => {
    const opts = parseContributeArgs([
      "--summary",
      "test",
      "--parent",
      "blake3:aaa",
      "--reviews",
      "blake3:bbb",
      "--responds-to",
      "blake3:ccc",
      "--adopts",
      "blake3:ddd",
      "--reproduces",
      "blake3:eee",
    ]);
    expect(opts.parent).toBe("blake3:aaa");
    expect(opts.reviews).toBe("blake3:bbb");
    expect(opts.respondsTo).toBe("blake3:ccc");
    expect(opts.adopts).toBe("blake3:ddd");
    expect(opts.reproduces).toBe("blake3:eee");
  });

  test("parses multiple --metric flags", () => {
    const opts = parseContributeArgs([
      "--summary",
      "test",
      "--metric",
      "tests_passing=47",
      "--metric",
      "throughput=14800",
    ]);
    expect(opts.metric).toEqual(["tests_passing=47", "throughput=14800"]);
  });

  test("parses multiple --tag flags", () => {
    const opts = parseContributeArgs([
      "--summary",
      "test",
      "--tag",
      "performance",
      "--tag",
      "database",
    ]);
    expect(opts.tags).toEqual(["performance", "database"]);
  });

  test("parses agent override flags", () => {
    const opts = parseContributeArgs([
      "--summary",
      "test",
      "--agent-id",
      "my-agent",
      "--provider",
      "openai",
    ]);
    expect(opts.agentOverrides.agentId).toBe("my-agent");
    expect(opts.agentOverrides.provider).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// validateContributeOptions
// ---------------------------------------------------------------------------

describe("validateContributeOptions", () => {
  test("valid work contribution passes", () => {
    const result = validateContributeOptions(makeContributeOptions());
    expect(result.valid).toBe(true);
  });

  test("rejects empty summary", () => {
    const result = validateContributeOptions(makeContributeOptions({ summary: "" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain("--summary is required and cannot be empty");
    }
  });

  test("rejects whitespace-only summary", () => {
    const result = validateContributeOptions(makeContributeOptions({ summary: "   " }));
    expect(result.valid).toBe(false);
  });

  test("rejects invalid kind", () => {
    const result = validateContributeOptions(
      makeContributeOptions({ kind: "invalid" as ContributeOptions["kind"] }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain("Invalid kind");
    }
  });

  test("rejects invalid mode", () => {
    const result = validateContributeOptions(
      makeContributeOptions({ mode: "invalid" as ContributeOptions["mode"] }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain("Invalid mode");
    }
  });

  // Mutual exclusion of ingestion modes
  test("rejects multiple ingestion modes", () => {
    const result = validateContributeOptions(
      makeContributeOptions({
        artifacts: ["./src"],
        fromGitDiff: "HEAD~1",
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain("mutually exclusive");
    }
  });

  test("rejects three ingestion modes", () => {
    const result = validateContributeOptions(
      makeContributeOptions({
        artifacts: ["./src"],
        fromGitDiff: "HEAD~1",
        fromGitTree: true,
      }),
    );
    expect(result.valid).toBe(false);
  });

  // Kind/relation consistency
  test("rejects review without --reviews", () => {
    const result = validateContributeOptions(makeContributeOptions({ kind: "review" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain("--kind review requires --reviews");
    }
  });

  test("rejects discussion without --responds-to", () => {
    const result = validateContributeOptions(makeContributeOptions({ kind: "discussion" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain("--kind discussion requires --responds-to");
    }
  });

  test("rejects adoption without --adopts", () => {
    const result = validateContributeOptions(makeContributeOptions({ kind: "adoption" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain("--kind adoption requires --adopts");
    }
  });

  test("rejects reproduction without --reproduces", () => {
    const result = validateContributeOptions(makeContributeOptions({ kind: "reproduction" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain("--kind reproduction requires --reproduces");
    }
  });

  test("accepts review with --reviews", () => {
    const result = validateContributeOptions(
      makeContributeOptions({ kind: "review", reviews: "blake3:abc" }),
    );
    expect(result.valid).toBe(true);
  });

  // Metric format
  test("rejects metric without =value", () => {
    const result = validateContributeOptions(makeContributeOptions({ metric: ["foo"] }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain("Invalid metric format");
    }
  });

  test("rejects metric with non-numeric value", () => {
    const result = validateContributeOptions(makeContributeOptions({ metric: ["foo=bar"] }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain("Value must be a number");
    }
  });

  test("accepts valid metric format", () => {
    const result = validateContributeOptions(
      makeContributeOptions({ metric: ["tests_passing=47", "throughput=14800"] }),
    );
    expect(result.valid).toBe(true);
  });

  // Score format
  test("rejects score without =value", () => {
    const result = validateContributeOptions(makeContributeOptions({ score: ["quality"] }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain("Invalid score format");
    }
  });

  // Multiple errors
  test("collects multiple errors", () => {
    const result = validateContributeOptions(
      makeContributeOptions({
        summary: "",
        kind: "review",
        artifacts: ["./src"],
        fromGitDiff: "HEAD",
        metric: ["bad"],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // Should have errors for: summary, mutual exclusion, missing --reviews, metric format
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    }
  });
});

// ---------------------------------------------------------------------------
// executeContribute
// ---------------------------------------------------------------------------

describe("executeContribute", () => {
  test("creates a work contribution with artifacts", async () => {
    const dir = await createTempDir();
    try {
      // Initialize grove
      await executeInit(makeInitOptions(dir));

      // Create an artifact file
      const artifactFile = join(dir, "output.txt");
      await writeFile(artifactFile, "test output");

      const result = await executeContribute(
        makeContributeOptions({
          summary: "Test work",
          artifacts: [artifactFile],
          cwd: dir,
        }),
      );

      expect(result.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates a contribution with metrics", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      const result = await executeContribute(
        makeContributeOptions({
          summary: "Metric work",
          metric: ["tests_passing=47", "throughput=14800"],
          cwd: dir,
        }),
      );

      expect(result.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates a contribution with tags", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      const result = await executeContribute(
        makeContributeOptions({
          summary: "Tagged work",
          tags: ["performance", "database"],
          cwd: dir,
        }),
      );

      expect(result.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates a review contribution with --reviews", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      // Create a work contribution first
      const work = await executeContribute(
        makeContributeOptions({
          summary: "Work to review",
          cwd: dir,
        }),
      );

      // Create a review
      const review = await executeContribute(
        makeContributeOptions({
          kind: "review",
          summary: "Looks good",
          reviews: work.cid,
          score: ["quality=8"],
          cwd: dir,
        }),
      );

      expect(review.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates a discussion contribution with --responds-to", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      const work = await executeContribute(
        makeContributeOptions({
          summary: "Original work",
          cwd: dir,
        }),
      );

      const discussion = await executeContribute(
        makeContributeOptions({
          kind: "discussion",
          summary: "Should we use polling or push?",
          respondsTo: work.cid,
          cwd: dir,
        }),
      );

      expect(discussion.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates an adoption contribution with --adopts", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      const work = await executeContribute(
        makeContributeOptions({
          summary: "Adoptable work",
          cwd: dir,
        }),
      );

      const adoption = await executeContribute(
        makeContributeOptions({
          kind: "adoption",
          summary: "Adopting this approach",
          adopts: work.cid,
          cwd: dir,
        }),
      );

      expect(adoption.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates a reproduction contribution with --reproduces", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      const work = await executeContribute(
        makeContributeOptions({
          summary: "Reproducible work",
          cwd: dir,
        }),
      );

      const reproduction = await executeContribute(
        makeContributeOptions({
          kind: "reproduction",
          summary: "Reproduced on A100",
          reproduces: work.cid,
          metric: ["val_bpb=0.9701"],
          cwd: dir,
        }),
      );

      expect(reproduction.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates contribution with --parent relation", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      const parent = await executeContribute(
        makeContributeOptions({
          summary: "Parent work",
          cwd: dir,
        }),
      );

      const child = await executeContribute(
        makeContributeOptions({
          summary: "Child work",
          parent: parent.cid,
          cwd: dir,
        }),
      );

      expect(child.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ingests report via --from-report", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      const reportPath = join(dir, "analysis.md");
      await writeFile(reportPath, "# Analysis\n\nFindings here.");

      const result = await executeContribute(
        makeContributeOptions({
          summary: "Analysis report",
          fromReport: reportPath,
          cwd: dir,
        }),
      );

      expect(result.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates exploration mode contribution", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      const result = await executeContribute(
        makeContributeOptions({
          mode: "exploration",
          summary: "Database pool exhausts at >100 connections",
          tags: ["performance", "database"],
          cwd: dir,
        }),
      );

      expect(result.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // -- Edge cases --

  test("errors when no grove initialized", async () => {
    const dir = await createTempDir();
    try {
      await expect(
        executeContribute(makeContributeOptions({ summary: "test", cwd: dir })),
      ).rejects.toThrow(/No grove found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("errors on nonexistent parent CID", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      await expect(
        executeContribute(
          makeContributeOptions({
            summary: "test",
            parent: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
            cwd: dir,
          }),
        ),
      ).rejects.toThrow(/Parent contribution not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("errors on nonexistent relation target CID", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      await expect(
        executeContribute(
          makeContributeOptions({
            kind: "review",
            summary: "test",
            reviews: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
            cwd: dir,
          }),
        ),
      ).rejects.toThrow(/Relation target contribution not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("errors on nonexistent artifact path", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      await expect(
        executeContribute(
          makeContributeOptions({
            summary: "test",
            artifacts: ["/nonexistent/path.txt"],
            cwd: dir,
          }),
        ),
      ).rejects.toThrow(/Artifact path not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("errors on nonexistent report path", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      await expect(
        executeContribute(
          makeContributeOptions({
            summary: "test",
            fromReport: "/nonexistent/report.md",
            cwd: dir,
          }),
        ),
      ).rejects.toThrow(/Report file not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("errors on invalid metric format in execute", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      await expect(
        executeContribute(
          makeContributeOptions({
            summary: "test",
            metric: ["bad_metric"],
            cwd: dir,
          }),
        ),
      ).rejects.toThrow(/Invalid contribute options/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("errors on mutually exclusive ingestion modes in execute", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      await expect(
        executeContribute(
          makeContributeOptions({
            summary: "test",
            artifacts: ["./src"],
            fromGitDiff: "HEAD~1",
            cwd: dir,
          }),
        ),
      ).rejects.toThrow(/mutually exclusive/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("allows duplicate contribution (idempotent put)", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      const opts = makeContributeOptions({
        summary: "Idempotent work",
        cwd: dir,
      });

      // The CID will differ because createdAt changes, but if we fix it...
      // For true idempotency, we'd need the same createdAt. Let's just
      // verify two contributions with different timestamps don't error.
      const r1 = await executeContribute(opts);
      const r2 = await executeContribute(opts);

      // Different CIDs (different createdAt) but both succeed
      expect(r1.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
      expect(r2.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Codex review fixes — enforcing store, mode resolution, metric direction
// ---------------------------------------------------------------------------

describe("Codex review fixes", () => {
  test("enforces artifact count limit from GROVE.md contract", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      // Overwrite GROVE.md with strict artifact limit
      const grovemdPath = join(dir, "GROVE.md");
      await writeFile(
        grovemdPath,
        [
          "---",
          "contract_version: 2",
          "name: test-grove",
          "mode: evaluation",
          "rate_limits:",
          "  max_artifacts_per_contribution: 1",
          "---",
          "# test",
        ].join("\n"),
      );

      // Create two artifact files
      const file1 = join(dir, "a.txt");
      const file2 = join(dir, "b.txt");
      await writeFile(file1, "AAA");
      await writeFile(file2, "BBB");

      // Contributing with 2 artifacts should fail due to enforcement
      await expect(
        executeContribute(
          makeContributeOptions({
            summary: "too many artifacts",
            artifacts: [file1, file2],
            cwd: dir,
          }),
        ),
      ).rejects.toThrow(/artifact/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inherits mode from GROVE.md contract when --mode is omitted", async () => {
    const dir = await createTempDir();
    try {
      // Initialize grove with exploration mode
      await executeInit({
        ...makeInitOptions(dir),
        mode: "exploration",
      });

      // Contribute without explicit --mode (mode: undefined)
      const result = await executeContribute(
        makeContributeOptions({
          summary: "implicit exploration",
          mode: undefined,
          cwd: dir,
        }),
      );

      // Read back from store to verify the mode was inherited
      const { SqliteContributionStore, initSqliteDb } = await import("../../local/sqlite-store.js");
      const dbPath = join(dir, ".grove", "store.sqlite");
      const db = initSqliteDb(dbPath);
      const store = new SqliteContributionStore(db);
      try {
        const contribution = await store.get(result.cid);
        expect(contribution).toBeDefined();
        const c = contribution as NonNullable<typeof contribution>;
        expect(c.mode).toBe("exploration");
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("explicit --mode evaluation overrides grove default exploration", async () => {
    const dir = await createTempDir();
    try {
      // Initialize grove with exploration mode
      await executeInit({
        ...makeInitOptions(dir),
        mode: "exploration",
      });

      // Contribute with explicit --mode evaluation
      const result = await executeContribute(
        makeContributeOptions({
          summary: "explicit evaluation override",
          mode: "evaluation",
          cwd: dir,
        }),
      );

      // Read back from store to verify explicit flag wins
      const { SqliteContributionStore, initSqliteDb } = await import("../../local/sqlite-store.js");
      const dbPath = join(dir, ".grove", "store.sqlite");
      const db = initSqliteDb(dbPath);
      const store = new SqliteContributionStore(db);
      try {
        const contribution = await store.get(result.cid);
        expect(contribution).toBeDefined();
        const c = contribution as NonNullable<typeof contribution>;
        expect(c.mode).toBe("evaluation");
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("errors on malformed GROVE.md instead of silently falling back", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));

      // Overwrite GROVE.md with invalid contract (missing required 'name' field)
      const grovemdPath = join(dir, "GROVE.md");
      await writeFile(grovemdPath, ["---", "contract_version: 2", "---", "# broken"].join("\n"));

      await expect(
        executeContribute(
          makeContributeOptions({
            summary: "should fail on bad contract",
            cwd: dir,
          }),
        ),
      ).rejects.toThrow(/Invalid GROVE.md/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses metric direction from GROVE.md contract instead of hardcoded maximize", async () => {
    const dir = await createTempDir();
    try {
      // Initialize grove with a minimize metric
      await executeInit({
        ...makeInitOptions(dir),
        metric: ["val_bpb:minimize"],
      });

      // Contribute with that metric
      const result = await executeContribute(
        makeContributeOptions({
          summary: "metric direction test",
          metric: ["val_bpb=0.97"],
          cwd: dir,
        }),
      );

      // Read back from store to verify the score direction
      const { SqliteContributionStore, initSqliteDb } = await import("../../local/sqlite-store.js");
      const dbPath = join(dir, ".grove", "store.sqlite");
      const db = initSqliteDb(dbPath);
      const store = new SqliteContributionStore(db);
      try {
        const contribution = await store.get(result.cid);
        expect(contribution).toBeDefined();
        const c = contribution as NonNullable<typeof contribution>;
        expect(c.scores).toBeDefined();
        const scores = c.scores as NonNullable<typeof c.scores>;
        const valBpb = scores.val_bpb as NonNullable<typeof scores.val_bpb>;
        expect(valBpb).toBeDefined();
        expect(valBpb.direction).toBe("minimize");
        expect(valBpb.value).toBe(0.97);
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E2E smoke test
// ---------------------------------------------------------------------------

describe("grove contribute E2E", () => {
  const cliPath = join(import.meta.dir, "..", "..", "cli", "main.ts");

  async function runCli(
    args: string[],
    cwd: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  }

  test("grove contribute via CLI creates a contribution", async () => {
    const dir = await createTempDir();
    try {
      await runCli(["init", "e2e-test"], dir);
      const { exitCode } = await runCli(
        ["contribute", "--summary", "E2E contribution", "--tag", "e2e"],
        dir,
      );
      expect(exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contribute with artifacts via CLI", async () => {
    const dir = await createTempDir();
    try {
      await runCli(["init", "e2e-test"], dir);
      await writeFile(join(dir, "output.txt"), "test output");

      const { exitCode, stdout } = await runCli(
        ["contribute", "--summary", "With artifact", "--artifacts", join(dir, "output.txt")],
        dir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("artifacts: 1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contribute with metrics via CLI", async () => {
    const dir = await createTempDir();
    try {
      await runCli(["init", "e2e-test", "--metric", "accuracy:maximize"], dir);

      const { exitCode, stdout } = await runCli(
        ["contribute", "--summary", "Metrics test", "--metric", "accuracy=0.95"],
        dir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("blake3:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contribute inherits exploration mode from grove via CLI", async () => {
    const dir = await createTempDir();
    try {
      await runCli(["init", "e2e-test", "--mode", "exploration"], dir);

      // No --mode flag: should inherit exploration from grove
      const { exitCode, stdout } = await runCli(
        ["contribute", "--summary", "Exploration work"],
        dir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("mode: exploration");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("explicit --mode evaluation overrides grove exploration via CLI", async () => {
    const dir = await createTempDir();
    try {
      await runCli(["init", "e2e-test", "--mode", "exploration"], dir);

      const { exitCode, stdout } = await runCli(
        ["contribute", "--summary", "Eval override", "--mode", "evaluation"],
        dir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("mode: evaluation");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contribute fails on malformed GROVE.md via CLI", async () => {
    const dir = await createTempDir();
    try {
      await runCli(["init", "e2e-test"], dir);

      // Corrupt the GROVE.md
      await writeFile(
        join(dir, "GROVE.md"),
        ["---", "contract_version: 2", "---", "# broken"].join("\n"),
      );

      const { exitCode, stderr } = await runCli(["contribute", "--summary", "Should fail"], dir);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Invalid GROVE.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contribute enforces artifact count limit via CLI", async () => {
    const dir = await createTempDir();
    try {
      await runCli(["init", "e2e-test"], dir);

      // Write GROVE.md with artifact limit
      await writeFile(
        join(dir, "GROVE.md"),
        [
          "---",
          "contract_version: 2",
          "name: e2e-test",
          "mode: evaluation",
          "rate_limits:",
          "  max_artifacts_per_contribution: 1",
          "---",
          "# e2e-test",
        ].join("\n"),
      );

      await writeFile(join(dir, "a.txt"), "AAA");
      await writeFile(join(dir, "b.txt"), "BBB");

      const { exitCode } = await runCli(
        [
          "contribute",
          "--summary",
          "Too many",
          "--artifacts",
          join(dir, "a.txt"),
          "--artifacts",
          join(dir, "b.txt"),
        ],
        dir,
      );
      expect(exitCode).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contribute with --from-report via CLI", async () => {
    const dir = await createTempDir();
    try {
      await runCli(["init", "e2e-test"], dir);
      await writeFile(join(dir, "report.md"), "# Report\n\nFindings.");

      const { exitCode, stdout } = await runCli(
        ["contribute", "--summary", "Report", "--from-report", join(dir, "report.md")],
        dir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("artifacts: 1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contribute with review kind via CLI", async () => {
    const dir = await createTempDir();
    try {
      await runCli(["init", "e2e-test"], dir);

      // Create a work contribution first
      const { stdout: workOut } = await runCli(["contribute", "--summary", "Work to review"], dir);
      const cidMatch = workOut.match(/blake3:[0-9a-f]{64}/);
      expect(cidMatch).not.toBeNull();
      const workCid = (cidMatch as RegExpMatchArray)[0];

      // Create a review
      const { exitCode, stdout } = await runCli(
        [
          "contribute",
          "--kind",
          "review",
          "--summary",
          "Looks good",
          "--reviews",
          workCid,
          "--score",
          "quality=8",
        ],
        dir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("kind: review");
      expect(stdout).toContain("relations: 1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contribute fails without --summary via CLI", async () => {
    const dir = await createTempDir();
    try {
      await runCli(["init", "e2e-test"], dir);

      const { exitCode } = await runCli(["contribute"], dir);
      expect(exitCode).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
