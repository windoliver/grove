/**
 * Tests for `grove init` command.
 *
 * Covers argument parsing, execution logic, and edge cases.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isValidProjectId } from "../../core/project-id.js";
import { loadRegistry } from "../../core/project-registry.js";
import type { InitOptions } from "./init.js";
import { ensureGitignore, executeInit, parseInitArgs } from "./init.js";

const INIT_INTEGRATION_TIMEOUT_MS = 30_000;

type InitTestBody = () => void | Promise<void>;

function initTest(name: string, fn: InitTestBody): void {
  test(name, fn, INIT_INTEGRATION_TIMEOUT_MS);
}

function initGitRepo(cwd: string, origin: string | null): void {
  const run = (args: string[]) => spawnSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  if (origin) run(["remote", "add", "origin", origin]);
}

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
  initTest("parses name from positional argument", () => {
    const opts = parseInitArgs(["my-project"]);
    expect(opts.name).toBe("my-project");
  });

  initTest("defaults name to basename of cwd when no positional", () => {
    const opts = parseInitArgs([]);
    // basename of process.cwd()
    expect(opts.name).toBe(basename(process.cwd()));
  });

  initTest("parses --mode flag", () => {
    const opts = parseInitArgs(["proj", "--mode", "exploration"]);
    expect(opts.mode).toBe("exploration");
  });

  initTest("defaults mode to evaluation", () => {
    const opts = parseInitArgs(["proj"]);
    expect(opts.mode).toBe("evaluation");
  });

  initTest("parses --seed flags", () => {
    const opts = parseInitArgs(["proj", "--seed", "./src", "--seed", "./tests"]);
    expect(opts.seed).toEqual(["./src", "./tests"]);
  });

  initTest("parses --metric flags", () => {
    const opts = parseInitArgs([
      "proj",
      "--metric",
      "val_bpb:minimize",
      "--metric",
      "accuracy:maximize",
    ]);
    expect(opts.metric).toEqual(["val_bpb:minimize", "accuracy:maximize"]);
  });

  initTest("parses --description flag", () => {
    const opts = parseInitArgs(["proj", "--description", "A test project"]);
    expect(opts.description).toBe("A test project");
  });

  initTest("parses --force flag", () => {
    const opts = parseInitArgs(["proj", "--force"]);
    expect(opts.force).toBe(true);
  });

  initTest("parses agent override flags", () => {
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

  initTest("throws on invalid mode", () => {
    expect(() => parseInitArgs(["proj", "--mode", "garbage"])).toThrow(/Invalid mode/);
  });

  initTest("throws on invalid metric format", () => {
    expect(() => parseInitArgs(["proj", "--metric", "val_bpb"])).toThrow(/Invalid metric format/);
  });

  initTest("throws on invalid metric direction", () => {
    expect(() => parseInitArgs(["proj", "--metric", "val_bpb:ascending"])).toThrow(
      /Invalid metric direction/,
    );
  });
});

// ---------------------------------------------------------------------------
// executeInit
// ---------------------------------------------------------------------------

describe("executeInit", () => {
  initTest("creates .grove directory structure", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeOptions({ name: "test-grove", cwd: dir }));

      // Check directory structure (bare init does not create GROVE.md)
      await access(join(dir, ".grove"));
      await access(join(dir, ".grove", "grove.db"));
      await access(join(dir, ".grove", "cas"));
      await access(join(dir, ".grove", "workspaces"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // -- Edge cases --

  initTest("errors on existing .grove/ without --force", async () => {
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

  initTest("allows re-init with --force", async () => {
    const dir = await createTempDir();
    try {
      // First init
      await executeInit(makeOptions({ name: "first", cwd: dir }));

      // Second init with --force
      await executeInit(makeOptions({ name: "second", cwd: dir, force: true }));

      // Bare init does not write GROVE.md — verify via grove.json instead
      const { readFile: rf } = await import("node:fs/promises");
      const configRaw = await rf(join(dir, ".grove", "grove.json"), "utf-8");
      const config = JSON.parse(configRaw) as { name: string };
      expect(config.name).toBe("second");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  initTest("errors on nonexistent seed path", async () => {
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

  initTest("seeds artifacts into CAS and creates root contribution", async () => {
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

  initTest("handles empty seed directory (valid, zero artifacts)", async () => {
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
  initTest("grove init via CLI creates .grove/", async () => {
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

      // Verify .grove/ exists (bare init does not create GROVE.md)
      await access(join(dir, ".grove"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("grove init — project identity (#288)", () => {
  initTest("creates .grove/project-id with a valid UUIDv4 on a fresh repo", async () => {
    const cwd = await createTempDir();
    initGitRepo(cwd, null);
    const registryPath = join(cwd, "test-registry.yaml");
    await executeInit(makeOptions({ name: "one", cwd }), undefined, { registryPath });
    const id = readFileSync(join(cwd, ".grove", "project-id"), "utf8").trim();
    expect(isValidProjectId(id)).toBe(true);
    await rm(cwd, { recursive: true, force: true });
  });
});

describe("grove init — #288 acceptance", () => {
  initTest("two independent clones of same origin (non-TTY) get distinct UUIDs", async () => {
    const sharedRegistry = join(await createTempDir(), "projects.yaml");

    const cloneA = await createTempDir();
    initGitRepo(cloneA, "git@github.com:foo/bar.git");
    const a = await executeInit(makeOptions({ name: "a", cwd: cloneA }), undefined, {
      registryPath: sharedRegistry,
      isTTY: false,
    });

    const cloneB = await createTempDir();
    initGitRepo(cloneB, "https://github.com/foo/bar.git");
    const b = await executeInit(makeOptions({ name: "b", cwd: cloneB }), undefined, {
      registryPath: sharedRegistry,
      isTTY: false,
    });

    expect(a.projectId).not.toBe(b.projectId);
    const reg = loadRegistry(sharedRegistry);
    expect(Object.keys(reg.projects)).toEqual(["github.com/foo/bar"]);
    expect(reg.projects["github.com/foo/bar"]?.id).toBe(a.projectId);

    await rm(cloneA, { recursive: true, force: true });
    await rm(cloneB, { recursive: true, force: true });
  });

  initTest("--unify merges second clone into first's id; registry stays single-entry", async () => {
    const sharedRegistry = join(await createTempDir(), "projects.yaml");

    const cloneA = await createTempDir();
    initGitRepo(cloneA, "git@github.com:foo/bar.git");
    const a = await executeInit(makeOptions({ name: "a", cwd: cloneA }), undefined, {
      registryPath: sharedRegistry,
    });

    const cloneB = await createTempDir();
    initGitRepo(cloneB, "https://github.com/foo/bar.git");
    const b = await executeInit(makeOptions({ name: "b", cwd: cloneB, unify: true }), undefined, {
      registryPath: sharedRegistry,
    });

    expect(b.projectId).toBe(a.projectId);
    const reg = loadRegistry(sharedRegistry);
    expect(Object.keys(reg.projects)).toEqual(["github.com/foo/bar"]);

    await rm(cloneA, { recursive: true, force: true });
    await rm(cloneB, { recursive: true, force: true });
  });

  initTest("re-running grove init leaves the project id unchanged", async () => {
    const registryPath = join(await createTempDir(), "projects.yaml");
    const cwd = await createTempDir();
    initGitRepo(cwd, "git@github.com:foo/bar.git");
    const first = await executeInit(makeOptions({ name: "one", cwd }), undefined, { registryPath });
    const second = await executeInit(makeOptions({ name: "one", cwd, force: true }), undefined, {
      registryPath,
    });
    expect(second.projectId).toBe(first.projectId);
    await rm(cwd, { recursive: true, force: true });
  });
});

describe("parseInitArgs — unify flags", () => {
  initTest("--unify sets unify: true", () => {
    const opts = parseInitArgs(["--unify"]);
    expect(opts.unify).toBe(true);
  });

  initTest("--no-unify sets unify: false", () => {
    const opts = parseInitArgs(["--no-unify"]);
    expect(opts.unify).toBe(false);
  });

  initTest("neither flag leaves unify undefined", () => {
    const opts = parseInitArgs([]);
    expect(opts.unify).toBeUndefined();
  });

  initTest("both --unify and --no-unify is an error", () => {
    expect(() => parseInitArgs(["--unify", "--no-unify"])).toThrow(/mutually exclusive/);
  });
});

describe("ensureGitignore", () => {
  test("creates .gitignore with both entries when absent", async () => {
    const dir = await createTempDir();
    try {
      await ensureGitignore(dir);
      const gi = readFileSync(join(dir, ".gitignore"), "utf8");
      expect(gi).toContain(".grove/");
      expect(gi).toContain("nexus-data/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("appends only missing entries, preserves existing content", async () => {
    const dir = await createTempDir();
    try {
      await writeFile(join(dir, ".gitignore"), "node_modules\n.grove/\n", "utf8");
      await ensureGitignore(dir);
      const gi = readFileSync(join(dir, ".gitignore"), "utf8");
      expect(gi).toContain("node_modules");
      // .grove/ already present — not duplicated
      expect(gi.match(/^\.grove\/$/gm)?.length).toBe(1);
      expect(gi).toContain("nexus-data/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent — second run is a no-op", async () => {
    const dir = await createTempDir();
    try {
      await ensureGitignore(dir);
      const first = readFileSync(join(dir, ".gitignore"), "utf8");
      await ensureGitignore(dir);
      const second = readFileSync(join(dir, ".gitignore"), "utf8");
      expect(second).toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
