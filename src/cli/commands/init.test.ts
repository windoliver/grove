/**
 * Tests for `grove init` command.
 *
 * Covers argument parsing, execution logic, and edge cases.
 */

import { describe, expect, test } from "bun:test";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { InitOptions } from "./init.js";
import { executeInit, parseInitArgs } from "./init.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeOptions(overrides?: Partial<InitOptions>): InitOptions {
  return {
    name: "test-grove",
    mode: "evaluation",
    seed: [],
    metric: [],
    force: false,
    agentOverrides: {},
    cwd: "/tmp/test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseInitArgs
// ---------------------------------------------------------------------------

describe("parseInitArgs", () => {
  test("parses name from positional argument", () => {
    const opts = parseInitArgs(["my-project"]);
    expect(opts.name).toBe("my-project");
  });

  test("defaults name to basename of cwd when no positional", () => {
    const opts = parseInitArgs([]);
    // basename of process.cwd()
    expect(opts.name).toBe(basename(process.cwd()));
  });

  test("parses --mode flag", () => {
    const opts = parseInitArgs(["proj", "--mode", "exploration"]);
    expect(opts.mode).toBe("exploration");
  });

  test("defaults mode to evaluation", () => {
    const opts = parseInitArgs(["proj"]);
    expect(opts.mode).toBe("evaluation");
  });

  test("parses --seed flags", () => {
    const opts = parseInitArgs(["proj", "--seed", "./src", "--seed", "./tests"]);
    expect(opts.seed).toEqual(["./src", "./tests"]);
  });

  test("parses --metric flags", () => {
    const opts = parseInitArgs([
      "proj",
      "--metric",
      "val_bpb:minimize",
      "--metric",
      "accuracy:maximize",
    ]);
    expect(opts.metric).toEqual(["val_bpb:minimize", "accuracy:maximize"]);
  });

  test("parses --description flag", () => {
    const opts = parseInitArgs(["proj", "--description", "A test project"]);
    expect(opts.description).toBe("A test project");
  });

  test("parses --force flag", () => {
    const opts = parseInitArgs(["proj", "--force"]);
    expect(opts.force).toBe(true);
  });

  test("parses agent override flags", () => {
    const opts = parseInitArgs([
      "proj",
      "--agent-id",
      "my-agent",
      "--agent-name",
      "Agent Smith",
      "--provider",
      "anthropic",
      "--model",
      "claude-4",
    ]);
    expect(opts.agentOverrides.agentId).toBe("my-agent");
    expect(opts.agentOverrides.agentName).toBe("Agent Smith");
    expect(opts.agentOverrides.provider).toBe("anthropic");
    expect(opts.agentOverrides.model).toBe("claude-4");
  });

  test("throws on invalid mode", () => {
    expect(() => parseInitArgs(["proj", "--mode", "garbage"])).toThrow(/Invalid mode/);
  });

  test("throws on invalid metric format", () => {
    expect(() => parseInitArgs(["proj", "--metric", "val_bpb"])).toThrow(/Invalid metric format/);
  });

  test("throws on invalid metric direction", () => {
    expect(() => parseInitArgs(["proj", "--metric", "val_bpb:ascending"])).toThrow(
      /Invalid metric direction/,
    );
  });
});

// ---------------------------------------------------------------------------
// executeInit
// ---------------------------------------------------------------------------

describe("executeInit", () => {
  test("creates .grove directory structure", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeOptions({ name: "test-grove", cwd: dir }));

      // Check directory structure
      await access(join(dir, ".grove"));
      await access(join(dir, ".grove", "grove.db"));
      await access(join(dir, ".grove", "cas"));
      await access(join(dir, ".grove", "workspaces"));
      await access(join(dir, "GROVE.md"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("generates GROVE.md with contract_version 2", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeOptions({ name: "my-project", cwd: dir }));

      const content = await readFile(join(dir, "GROVE.md"), "utf-8");
      expect(content).toContain("contract_version: 2");
      expect(content).toContain("name: my-project");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("generates GROVE.md with mode", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeOptions({ name: "explore", mode: "exploration", cwd: dir }));

      const content = await readFile(join(dir, "GROVE.md"), "utf-8");
      expect(content).toContain("mode: exploration");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("generates GROVE.md with metrics when specified", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(
        makeOptions({
          name: "metrics-test",
          metric: ["val_bpb:minimize", "accuracy:maximize"],
          cwd: dir,
        }),
      );

      const content = await readFile(join(dir, "GROVE.md"), "utf-8");
      expect(content).toContain("val_bpb:");
      expect(content).toContain("direction: minimize");
      expect(content).toContain("accuracy:");
      expect(content).toContain("direction: maximize");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("generates GROVE.md with custom description", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(
        makeOptions({
          name: "desc-test",
          description: "My custom description",
          cwd: dir,
        }),
      );

      const content = await readFile(join(dir, "GROVE.md"), "utf-8");
      expect(content).toContain("description: My custom description");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // -- Edge cases --

  test("errors on existing .grove/ without --force", async () => {
    const dir = await createTempDir();
    try {
      await mkdir(join(dir, ".grove"), { recursive: true });

      await expect(executeInit(makeOptions({ name: "test", cwd: dir }))).rejects.toThrow(
        /already initialized/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("allows re-init with --force", async () => {
    const dir = await createTempDir();
    try {
      // First init
      await executeInit(makeOptions({ name: "first", cwd: dir }));

      // Second init with --force
      await executeInit(makeOptions({ name: "second", cwd: dir, force: true }));

      const content = await readFile(join(dir, "GROVE.md"), "utf-8");
      expect(content).toContain("name: second");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("errors on nonexistent seed path", async () => {
    const dir = await createTempDir();
    try {
      await expect(
        executeInit(makeOptions({ name: "test", seed: ["/nonexistent/path"], cwd: dir })),
      ).rejects.toThrow(/Seed path not found/);

      // Verify .grove/ was NOT created (fail fast before creating state)
      const entries = await readdir(dir);
      expect(entries).not.toContain(".grove");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("seeds artifacts into CAS and creates root contribution", async () => {
    const dir = await createTempDir();
    try {
      // Create seed files
      const seedDir = join(dir, "seed");
      await mkdir(seedDir, { recursive: true });
      await writeFile(join(seedDir, "data.txt"), "seed data");

      await executeInit(
        makeOptions({
          name: "seeded",
          seed: [seedDir],
          cwd: dir,
          agentOverrides: { agentId: "test-agent" },
        }),
      );

      // Verify CAS has content
      const casEntries = await readdir(join(dir, ".grove", "cas"));
      expect(casEntries.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles empty seed directory (valid, zero artifacts)", async () => {
    const dir = await createTempDir();
    try {
      const emptyDir = join(dir, "empty-seed");
      await mkdir(emptyDir, { recursive: true });

      // Should not throw
      await executeInit(makeOptions({ name: "empty-seed-test", seed: [emptyDir], cwd: dir }));

      await access(join(dir, ".grove"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E2E smoke test
// ---------------------------------------------------------------------------

describe("grove init E2E", () => {
  test("grove init via CLI creates .grove/ and GROVE.md", async () => {
    const dir = await createTempDir();
    try {
      const cliPath = join(import.meta.dir, "..", "..", "cli", "main.ts");
      const proc = Bun.spawn(["bun", "run", cliPath, "init", "e2e-test"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      // Drain stdout/stderr to avoid pipe hang
      await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);

      // Verify files exist
      await access(join(dir, ".grove"));
      await access(join(dir, "GROVE.md"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
