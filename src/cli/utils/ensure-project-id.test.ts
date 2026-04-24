import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { readProjectId } from "../../core/project-id.js";
import { loadRegistry } from "../../core/project-registry.js";
import type { EnsureOpts } from "./ensure-project-id.js";
import { ensureProjectId } from "./ensure-project-id.js";

function mkTmp(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mkClone(origin: string | null): string {
  const dir = mkTmp("grove-ensure-clone");
  const run = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  if (origin) run(["remote", "add", "origin", origin]);
  return dir;
}

function mkGroveDir(parent: string): string {
  const g = join(parent, ".grove");
  mkdirSync(g, { recursive: true });
  return g;
}

function baseOpts(overrides: Partial<EnsureOpts>): EnsureOpts {
  const now = new Date("2026-04-24T00:00:00.000Z");
  return {
    groveDir: overrides.groveDir ?? "",
    cwd: overrides.cwd ?? "",
    registryPath: overrides.registryPath ?? join(mkTmp("registry"), "projects.yaml"),
    isTTY: false,
    now: () => now,
    ...overrides,
  };
}

describe("ensureProjectId — no prompt paths", () => {
  test("returns 'local' when .grove/project-id already exists", async () => {
    const clone = mkClone("git@github.com:foo/bar.git");
    const groveDir = mkGroveDir(clone);
    writeFileSync(join(groveDir, "project-id"), "550e8400-e29b-41d4-a716-446655440000\n");
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const res = await ensureProjectId(baseOpts({ groveDir, cwd: clone, registryPath }));
    expect(res.source).toBe("local");
    expect(res.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(loadRegistry(registryPath)).toEqual({ version: 1, projects: {} });
  });

  test("generates new + skips registry when no git origin", async () => {
    const clone = mkClone(null);
    const groveDir = mkGroveDir(clone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const res = await ensureProjectId(baseOpts({ groveDir, cwd: clone, registryPath }));
    expect(res.source).toBe("generated");
    expect(res.origin).toBeNull();
    expect(res.registered).toBe(false);
    expect(readProjectId(groveDir)).toBe(res.id);
    expect(loadRegistry(registryPath)).toEqual({ version: 1, projects: {} });
  });

  test("generates new + registers entry on registry miss", async () => {
    const clone = mkClone("git@github.com:foo/bar.git");
    const groveDir = mkGroveDir(clone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const res = await ensureProjectId(baseOpts({ groveDir, cwd: clone, registryPath }));
    expect(res.source).toBe("generated");
    expect(res.origin).toBe("github.com/foo/bar");
    expect(res.registered).toBe(true);
    const reg = loadRegistry(registryPath);
    expect(reg.projects["github.com/foo/bar"]?.id).toBe(res.id);
    expect(reg.projects["github.com/foo/bar"]?.name).toBe("foo/bar");
  });

  test("adopts existing id when registry hits and --unify", async () => {
    const firstClone = mkClone("git@github.com:foo/bar.git");
    const firstGrove = mkGroveDir(firstClone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir: firstGrove, cwd: firstClone, registryPath }),
    );

    const secondClone = mkClone("https://github.com/foo/bar.git");
    const secondGrove = mkGroveDir(secondClone);
    const second = await ensureProjectId(
      baseOpts({
        groveDir: secondGrove,
        cwd: secondClone,
        registryPath,
        unify: true,
      }),
    );
    expect(second.source).toBe("registry");
    expect(second.id).toBe(first.id);
    expect(readProjectId(secondGrove)).toBe(first.id);
  });

  test("generates new id when registry hits and --no-unify", async () => {
    const firstClone = mkClone("git@github.com:foo/bar.git");
    const firstGrove = mkGroveDir(firstClone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir: firstGrove, cwd: firstClone, registryPath }),
    );

    const secondClone = mkClone("https://github.com/foo/bar.git");
    const secondGrove = mkGroveDir(secondClone);
    const second = await ensureProjectId(
      baseOpts({
        groveDir: secondGrove,
        cwd: secondClone,
        registryPath,
        unify: false,
      }),
    );
    expect(second.source).toBe("generated");
    expect(second.id).not.toBe(first.id);
    expect(second.registered).toBe(false);
    const reg = loadRegistry(registryPath);
    expect(reg.projects["github.com/foo/bar"]?.id).toBe(first.id);
  });

  test("generates new id when registry hits and non-TTY, no flag", async () => {
    const firstClone = mkClone("git@github.com:foo/bar.git");
    const firstGrove = mkGroveDir(firstClone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir: firstGrove, cwd: firstClone, registryPath }),
    );

    const secondClone = mkClone("https://github.com/foo/bar.git");
    const secondGrove = mkGroveDir(secondClone);
    const second = await ensureProjectId(
      baseOpts({
        groveDir: secondGrove,
        cwd: secondClone,
        registryPath,
        isTTY: false,
      }),
    );
    expect(second.source).toBe("generated");
    expect(second.id).not.toBe(first.id);
  });

  test("is idempotent — second call on an initialized clone returns local", async () => {
    const clone = mkClone("git@github.com:foo/bar.git");
    const groveDir = mkGroveDir(clone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(baseOpts({ groveDir, cwd: clone, registryPath }));
    const second = await ensureProjectId(baseOpts({ groveDir, cwd: clone, registryPath }));
    expect(second.source).toBe("local");
    expect(second.id).toBe(first.id);
  });

  test("throws on malformed local project-id", async () => {
    const clone = mkClone("git@github.com:foo/bar.git");
    const groveDir = mkGroveDir(clone);
    writeFileSync(join(groveDir, "project-id"), "garbage\n");
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    await expect(ensureProjectId(baseOpts({ groveDir, cwd: clone, registryPath }))).rejects.toThrow(
      /Invalid project id/,
    );
  });
});

function stdinFeeding(input: string): NodeJS.ReadableStream {
  const s = new PassThrough();
  s.end(input);
  return s;
}

function captureStdout(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const s = new PassThrough();
  s.on("data", (b) => chunks.push(b.toString("utf8")));
  return { stream: s, text: () => chunks.join("") };
}

describe("ensureProjectId — TTY prompt", () => {
  test("TTY + 'y\\n' adopts", async () => {
    const firstClone = mkClone("git@github.com:foo/bar.git");
    const firstGrove = mkGroveDir(firstClone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir: firstGrove, cwd: firstClone, registryPath }),
    );

    const secondClone = mkClone("https://github.com/foo/bar.git");
    const secondGrove = mkGroveDir(secondClone);
    const out = captureStdout();
    const second = await ensureProjectId(
      baseOpts({
        groveDir: secondGrove,
        cwd: secondClone,
        registryPath,
        isTTY: true,
        stdin: stdinFeeding("y\n"),
        stdout: out.stream,
      }),
    );
    expect(second.source).toBe("registry");
    expect(second.id).toBe(first.id);
    expect(out.text()).toMatch(/Unify\?/);
  });

  test("TTY + Enter (default Y) adopts", async () => {
    const firstClone = mkClone("git@github.com:foo/bar.git");
    const firstGrove = mkGroveDir(firstClone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir: firstGrove, cwd: firstClone, registryPath }),
    );

    const secondClone = mkClone("https://github.com/foo/bar.git");
    const secondGrove = mkGroveDir(secondClone);
    const second = await ensureProjectId(
      baseOpts({
        groveDir: secondGrove,
        cwd: secondClone,
        registryPath,
        isTTY: true,
        stdin: stdinFeeding("\n"),
        stdout: new PassThrough(),
      }),
    );
    expect(second.source).toBe("registry");
    expect(second.id).toBe(first.id);
  });

  test("TTY + 'n\\n' creates new", async () => {
    const firstClone = mkClone("git@github.com:foo/bar.git");
    const firstGrove = mkGroveDir(firstClone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir: firstGrove, cwd: firstClone, registryPath }),
    );

    const secondClone = mkClone("https://github.com/foo/bar.git");
    const secondGrove = mkGroveDir(secondClone);
    const second = await ensureProjectId(
      baseOpts({
        groveDir: secondGrove,
        cwd: secondClone,
        registryPath,
        isTTY: true,
        stdin: stdinFeeding("n\n"),
        stdout: new PassThrough(),
      }),
    );
    expect(second.source).toBe("generated");
    expect(second.id).not.toBe(first.id);
  });
});
