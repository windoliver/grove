# Bare-Clone Repo Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `provisionWorkspace`'s single-repo `repoRoot` coupling with a user-wide bare-clone cache (`resolveRepo(RepoRef)` → `bareClonePath`). Sessions gain a `repos: RepoRef[]` config field alongside the existing `projectRoot`. Adds `grove repo list` / `grove repo prune` CLI.

**Architecture:** Two new pure/IO-separated modules — `src/core/repo-ref.ts` (URL normalization + cache-key derivation, zero I/O) and `src/core/repo-cache.ts` (clone/fetch/lock/manifest, one exported function `resolveRepo`). `workspace-provisioner.ts` changes one field (`repoRoot` → `bareClonePath`). Session configs gain `repos`; `projectRoot` stays for its launcher-dir job. Lockfiles live at `<cacheRoot>/.locks/` — outside cache entries — so corruption recovery never unlinks a held lock. No Nexus coupling.

**Tech Stack:** TypeScript · Bun (runtime + test runner) · `node:child_process` · `node:fs/promises` · `proper-lockfile` (new dep — cross-platform `flock`-equivalent) · Biome · TypeScript strict mode.

---

## Spec Reference

`docs/superpowers/specs/2026-04-21-bare-clone-repo-cache-design.md`

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `src/core/repo-ref.ts` | `RepoRef` type; `normalizeUrl`; `deriveCachePath`; path-safety validator. Pure. | **Create** |
| `src/core/repo-ref.test.ts` | Normalization table; path-safety rejection. | **Create** |
| `src/core/repo-cache.ts` | `resolveRepo(ref, opts)`; cache-root resolution; clone/fetch; flock; manifest; corruption recovery. | **Create** |
| `src/core/repo-cache.test.ts` | Integration tests with `file://` fixture bare repos. | **Create** |
| `src/core/workspace-provisioner.ts` | `WorkspaceProvisionOptions.repoRoot` → `bareClonePath`; same for `cleanupSessionWorkspaces`. | **Modify** |
| `src/core/workspace-provisioner.test.ts` | Existing tests updated to pass `bareClonePath` (fixture bare clone). | **Modify** |
| `src/core/session-orchestrator.ts` | Add `repos: RepoRef[]` + `repoCache` to config; resolve at start; pass `bareClonePath` to provisioner. Keep `projectRoot` unchanged for launcher-dir uses. | **Modify** |
| `src/core/session-orchestrator.test.ts` | Update construction; resolve against fixture. | **Modify** |
| `src/tui/spawn-manager.ts` | Same split as orchestrator. | **Modify** |
| `src/tui/spawn-manager.test.ts` | Same updates. | **Modify** |
| `src/core/topology.ts` | `AgentRole.repoIndex?: number` (default 0). Schema + wire. | **Modify** |
| `src/core/topology.test.ts` | Wire parses; strict rejection still works. | **Modify** |
| `src/cli/commands/repo.ts` | `grove repo list` / `grove repo prune` / `grove repo fetch`. | **Create** |
| `src/cli/commands/repo.test.ts` | Exercises the subcommand handlers end-to-end. | **Create** |
| `src/cli/main.ts` | Register `repo` subcommand. | **Modify** |
| `src/cli/commands/up.ts` (or equivalent) | Add `--repo` flag; reject >1 value today; default to cwd `local` ref. | **Modify** |
| `tests/e2e/repo-cache-session.test.ts` | End-to-end — session against a `file://` fixture completes. | **Create** |
| `README.md` / `QUICKSTART.md` / `GROVE.md` | Document `--repo`, cache root, `grove repo` commands. | **Modify** |
| `package.json` | Add `proper-lockfile` + `@types/proper-lockfile`. | **Modify** |

No files are split or deleted. Each modified file keeps its current responsibility; only the fields named above change.

---

## Conventions

- **Runtime / tests:** Bun. Test commands below use `bun test <path>` or `bun test <path> -t '<name>'`.
- **Typecheck:** `bun run typecheck`.
- **Lint/format:** `bun run check`.
- **Commit messages:** follow repo style (short imperative subject, `feat:` / `fix:` / `refactor:` / `test:` / `docs:`).
- **Never skip hooks** (`--no-verify` is forbidden).
- **Never contact a real git remote in tests** — use `file://` URLs pointing at fixture bare repos created in `beforeAll`.

---

## Task 1: Add `proper-lockfile` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the runtime + type dependency**

Run:
```bash
bun add proper-lockfile@^4.1.2
bun add -D @types/proper-lockfile@^4.1.4
```

- [ ] **Step 2: Verify install**

Run: `grep -E '"proper-lockfile"|"@types/proper-lockfile"' package.json`
Expected: both present.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add proper-lockfile for cross-platform file locks"
```

---

## Task 2: `repo-ref.ts` — types + URL normalization

**Files:**
- Create: `src/core/repo-ref.ts`
- Create: `src/core/repo-ref.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/repo-ref.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  deriveCachePath,
  normalizeUrl,
  type NormalizedRepo,
  type RepoRef,
} from "./repo-ref.js";

describe("normalizeUrl", () => {
  const cases: ReadonlyArray<readonly [string, NormalizedRepo]> = [
    ["git@github.com:foo/bar.git",         { host: "github.com", path: "foo/bar" }],
    ["git@github.com:foo/bar",             { host: "github.com", path: "foo/bar" }],
    ["https://github.com/foo/bar",         { host: "github.com", path: "foo/bar" }],
    ["https://github.com/foo/bar.git",     { host: "github.com", path: "foo/bar" }],
    ["https://github.com/foo/bar/",        { host: "github.com", path: "foo/bar" }],
    ["https://GitHub.com/Foo/Bar.git",     { host: "github.com", path: "Foo/Bar" }],
    ["https://user@github.com/foo/bar",    { host: "github.com", path: "foo/bar" }],
    ["ssh://git@gitlab.com/group/sub/p.git", { host: "gitlab.com", path: "group/sub/p" }],
    ["file:///abs/path/to/repo",           { host: "local",      path: "abs/path/to/repo" }],
    ["/abs/path/to/repo",                  { host: "local",      path: "abs/path/to/repo" }],
    ["/abs/path/to/repo.git",              { host: "local",      path: "abs/path/to/repo" }],
  ];

  for (const [input, expected] of cases) {
    test(`"${input}" normalizes correctly`, () => {
      expect(normalizeUrl(input)).toEqual(expected);
    });
  }

  test("rejects path with `..` traversal", () => {
    expect(() => normalizeUrl("https://github.com/foo/../bar")).toThrow(/traversal/);
  });

  test("rejects path with leading-dot component", () => {
    expect(() => normalizeUrl("https://github.com/foo/.hidden/bar")).toThrow(/leading dot/);
  });

  test("rejects empty host", () => {
    expect(() => normalizeUrl("https:///foo/bar")).toThrow(/host/);
  });

  test("rejects empty path", () => {
    expect(() => normalizeUrl("https://github.com/")).toThrow(/path/);
  });

  test("rejects non-absolute local path", () => {
    expect(() => normalizeUrl("relative/path/repo")).toThrow(/absolute/);
  });
});

describe("deriveCachePath", () => {
  test("produces host/path.git layout", () => {
    expect(deriveCachePath({ host: "github.com", path: "foo/bar" })).toBe("github.com/foo/bar.git");
  });

  test("preserves nested path segments", () => {
    expect(deriveCachePath({ host: "gitlab.com", path: "group/sub/p" })).toBe("gitlab.com/group/sub/p.git");
  });

  test("local namespace", () => {
    expect(deriveCachePath({ host: "local", path: "abs/path/to/repo" })).toBe("local/abs/path/to/repo.git");
  });
});

describe("RepoRef", () => {
  test("discriminated union compiles", () => {
    const a: RepoRef = { kind: "local", path: "/tmp/x" };
    const b: RepoRef = { kind: "url", url: "https://github.com/foo/bar" };
    const c: RepoRef = { kind: "url", url: "https://github.com/foo/bar", ref: "main" };
    expect([a.kind, b.kind, c.kind]).toEqual(["local", "url", "url"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/repo-ref.test.ts`
Expected: FAIL — module not found / exports missing.

- [ ] **Step 3: Implement `repo-ref.ts`**

Create `src/core/repo-ref.ts`:

```ts
/**
 * Repo reference + URL normalization.
 *
 * Pure module: no I/O. Consumers use `normalizeUrl` to canonicalize a
 * repo reference, then `deriveCachePath` to get a cache-entry path
 * segment. Path-safety is enforced here — callers must not trust
 * `path.join` alone to sanitize a remote-controlled URL.
 */

export type RepoRef =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "url"; readonly url: string; readonly ref?: string };

export interface NormalizedRepo {
  readonly host: string;
  readonly path: string;
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const SCP_LIKE_RE = /^([^@\s]+@)?([^:/\s]+):(.+)$/;

export function normalizeUrl(raw: string): NormalizedRepo {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("empty repo reference");

  const scpMatch = !SCHEME_RE.test(trimmed) && !trimmed.startsWith("/")
    ? trimmed.match(SCP_LIKE_RE)
    : null;

  let host: string;
  let rawPath: string;

  if (scpMatch) {
    host = scpMatch[2]!;
    rawPath = scpMatch[3]!;
  } else if (SCHEME_RE.test(trimmed)) {
    const u = new URL(trimmed);
    if (u.protocol === "file:") {
      host = "local";
      rawPath = u.pathname;
    } else {
      host = u.hostname;
      rawPath = u.pathname.replace(/^\//, "");
    }
  } else if (trimmed.startsWith("/")) {
    host = "local";
    rawPath = trimmed.slice(1);
  } else {
    throw new Error(`repo reference must be absolute or a known URL scheme: ${trimmed}`);
  }

  if (host === "") throw new Error(`normalized host is empty: ${raw}`);

  const cleaned = rawPath
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

  if (cleaned === "") throw new Error(`normalized path is empty: ${raw}`);

  validatePathSegments(cleaned);

  return { host: host.toLowerCase(), path: cleaned };
}

function validatePathSegments(path: string): void {
  for (const seg of path.split("/")) {
    if (seg === "") throw new Error(`invalid path (empty segment): ${path}`);
    if (seg === ".." || seg === ".") {
      throw new Error(`invalid path (traversal '${seg}'): ${path}`);
    }
    if (seg.startsWith(".")) {
      throw new Error(`invalid path (leading dot in segment '${seg}'): ${path}`);
    }
  }
}

export function deriveCachePath(n: NormalizedRepo): string {
  return `${n.host}/${n.path}.git`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/repo-ref.test.ts`
Expected: all green.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/repo-ref.ts src/core/repo-ref.test.ts
git commit -m "feat(repo-ref): RepoRef type + URL normalization + cache-key derivation"
```

---

## Task 3: `repo-cache.ts` scaffold — types + cache-root resolution

**Files:**
- Create: `src/core/repo-cache.ts`
- Create: `src/core/repo-cache.test.ts`

- [ ] **Step 1: Write failing tests for cache-root resolution**

Create `src/core/repo-cache.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveCacheRoot } from "./repo-cache.js";

describe("resolveCacheRoot", () => {
  test("honors GROVE_REPO_CACHE when set", () => {
    const env = { GROVE_REPO_CACHE: "/tmp/custom-cache" } as NodeJS.ProcessEnv;
    expect(resolveCacheRoot({ env })).toBe("/tmp/custom-cache");
  });

  test("honors explicit option over env", () => {
    const env = { GROVE_REPO_CACHE: "/tmp/env-cache" } as NodeJS.ProcessEnv;
    expect(resolveCacheRoot({ env, override: "/tmp/opt-cache" })).toBe("/tmp/opt-cache");
  });

  test("uses XDG_CACHE_HOME when set", () => {
    const env = { XDG_CACHE_HOME: "/xdg/cache" } as NodeJS.ProcessEnv;
    expect(resolveCacheRoot({ env, home: "/home/me" })).toBe("/xdg/cache/grove/repo-cache");
  });

  test("falls back to ~/.cache/grove/repo-cache", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveCacheRoot({ env, home: "/home/me" })).toBe(join("/home/me", ".cache/grove/repo-cache"));
  });

  test("rejects empty HOME with no env overrides", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(() => resolveCacheRoot({ env, home: "" })).toThrow(/HOME/);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `bun test src/core/repo-cache.test.ts -t resolveCacheRoot`
Expected: module not found.

- [ ] **Step 3: Scaffold `repo-cache.ts`**

Create `src/core/repo-cache.ts`:

```ts
/**
 * Bare-clone repo cache.
 *
 * Exposes one primary function, `resolveRepo`, which materializes a
 * RepoRef into a bare clone on disk and returns the path. Clones and
 * fetches are serialized per cache entry via `proper-lockfile`; lock
 * files live at `<cacheRoot>/.locks/` (outside the cache entry) so
 * corruption recovery cannot unlink a held lock.
 */

import { join } from "node:path";
import type { RepoRef } from "./repo-ref.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveRepoOptions {
  readonly fresh?: boolean;
  readonly cacheRoot?: string;
  readonly fetchTtlMs?: number;
  readonly timeoutMs?: number;
}

export interface ResolvedRepo {
  readonly ref: RepoRef;
  readonly bareClonePath: string;
  readonly key: string;
  readonly fetched: boolean;
  readonly stale: boolean;
}

interface CacheRootInputs {
  readonly env: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly override?: string;
}

// ---------------------------------------------------------------------------
// Cache-root resolution
// ---------------------------------------------------------------------------

export function resolveCacheRoot(inputs: CacheRootInputs): string {
  if (inputs.override) return inputs.override;
  const explicit = inputs.env.GROVE_REPO_CACHE;
  if (explicit && explicit.length > 0) return explicit;
  const xdg = inputs.env.XDG_CACHE_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "grove", "repo-cache");
  const home = inputs.home;
  if (!home) throw new Error("cannot resolve cache root: no HOME and no XDG_CACHE_HOME");
  return join(home, ".cache", "grove", "repo-cache");
}

// ---------------------------------------------------------------------------
// resolveRepo — stub (filled in subsequent tasks)
// ---------------------------------------------------------------------------

export async function resolveRepo(
  _ref: RepoRef,
  _opts?: ResolveRepoOptions,
): Promise<ResolvedRepo> {
  throw new Error("resolveRepo: not implemented");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/repo-cache.test.ts -t resolveCacheRoot`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/core/repo-cache.ts src/core/repo-cache.test.ts
git commit -m "feat(repo-cache): scaffold + cache-root resolution (GROVE_REPO_CACHE / XDG / ~/.cache)"
```

---

## Task 4: `resolveRepo` — local path with no origin (pass-through)

**Files:**
- Modify: `src/core/repo-cache.ts`
- Modify: `src/core/repo-cache.test.ts`

- [ ] **Step 1: Add failing test**

Append to `src/core/repo-cache.test.ts`:

```ts
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveRepo } from "./repo-cache.js";

describe("resolveRepo — local path without origin", () => {
  test("returns the local path verbatim and skips the cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-rc-local-"));
    try {
      execSync("git init", { cwd: dir, stdio: "pipe" });
      execSync('git config user.email "t@t"', { cwd: dir, stdio: "pipe" });
      execSync('git config user.name "t"', { cwd: dir, stdio: "pipe" });
      execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "pipe" });

      const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
      try {
        const result = await resolveRepo({ kind: "local", path: dir }, { cacheRoot });
        expect(result.bareClonePath).toBe(dir);
        expect(result.fetched).toBe(false);
        expect(result.stale).toBe(false);
        expect(result.key).toBe("local");
      } finally {
        rmSync(cacheRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/core/repo-cache.test.ts -t "local path without origin"`
Expected: throws "not implemented".

- [ ] **Step 3: Implement pass-through branch**

In `src/core/repo-cache.ts`, replace the stub `resolveRepo` with:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function readOriginUrl(localPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", localPath, "remote", "get-url", "origin"], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export async function resolveRepo(
  ref: RepoRef,
  opts: ResolveRepoOptions = {},
): Promise<ResolvedRepo> {
  if (ref.kind === "local") {
    const origin = await readOriginUrl(ref.path);
    if (origin === null) {
      return {
        ref,
        bareClonePath: ref.path,
        key: "local",
        fetched: false,
        stale: false,
      };
    }
    // origin-present case handled in Task 11 — delegate to URL path
    return resolveRepo({ kind: "url", url: origin }, opts);
  }
  throw new Error("resolveRepo: URL path not yet implemented");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/repo-cache.test.ts -t "local path without origin"`
Expected: PASS.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/repo-cache.ts src/core/repo-cache.test.ts
git commit -m "feat(repo-cache): pass-through for local repos without origin"
```

---

## Task 5: `resolveRepo` — fresh clone path

Implements steps 2–4 of the spec's `resolveRepo` flow (derive cache dir, flock, clone `--bare`, write manifest + `.ok`).

**Files:**
- Modify: `src/core/repo-cache.ts`
- Modify: `src/core/repo-cache.test.ts`

- [ ] **Step 1: Add test fixture helper**

Append a shared helper near the top of `src/core/repo-cache.test.ts` (after existing imports):

```ts
function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-rc-fx-"));
  execSync("git init --bare", { cwd: dir, stdio: "pipe" });
  // Push an initial commit via a scratch clone
  const scratch = mkdtempSync(join(tmpdir(), "grove-rc-scratch-"));
  execSync(`git clone "${dir}" "${scratch}"`, { stdio: "pipe" });
  execSync('git config user.email "t@t"', { cwd: scratch, stdio: "pipe" });
  execSync('git config user.name "t"', { cwd: scratch, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: scratch, stdio: "pipe" });
  execSync("git branch -M main", { cwd: scratch, stdio: "pipe" });
  execSync("git push origin main", { cwd: scratch, stdio: "pipe" });
  rmSync(scratch, { recursive: true, force: true });
  return dir;
}
```

- [ ] **Step 2: Write failing test — fresh clone**

Append:

```ts
import { existsSync, readFileSync } from "node:fs";

describe("resolveRepo — fresh clone", () => {
  test("clones into cache, writes .ok, manifest, last-fetch", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      const result = await resolveRepo(
        { kind: "url", url: `file://${fixture}` },
        { cacheRoot },
      );

      expect(result.fetched).toBe(true);
      expect(result.stale).toBe(false);
      expect(result.key).toBe(`local/${fixture.replace(/^\//, "")}.git`);
      expect(existsSync(join(result.bareClonePath, "HEAD"))).toBe(true);
      expect(existsSync(join(result.bareClonePath, ".grove-cache", ".ok"))).toBe(true);
      expect(existsSync(join(result.bareClonePath, ".grove-cache", "last-fetch"))).toBe(true);

      const manifest = JSON.parse(
        readFileSync(join(result.bareClonePath, ".grove-cache", "manifest.json"), "utf-8"),
      );
      expect(manifest.canonicalUrl).toBe(`file://${fixture}`);
      expect(manifest.aliases).toEqual([`file://${fixture}`]);
      expect(typeof manifest.createdAt).toBe("string");
      expect(typeof manifest.lastFetchedAt).toBe("string");
      expect(typeof manifest.lastAccessedAt).toBe("string");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run — expect failure**

Run: `bun test src/core/repo-cache.test.ts -t "fresh clone"`
Expected: throws "URL path not yet implemented".

- [ ] **Step 4: Implement the URL + clone path**

In `src/core/repo-cache.ts`:

Add imports:
```ts
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import lockfile from "proper-lockfile";
import { deriveCachePath, normalizeUrl } from "./repo-ref.js";
```

Add helpers + fill in `resolveRepo`:

```ts
interface Manifest {
  canonicalUrl: string;
  aliases: string[];
  createdAt: string;
  lastFetchedAt: string;
  lastAccessedAt: string;
}

function encodeLockName(key: string): string {
  return key.replace(/\//g, "__");
}

async function runGit(
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<void> {
  const controller = new AbortController();
  const timer = opts.timeoutMs
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : undefined;
  try {
    await execFileAsync("git", args as string[], {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      signal: controller.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
}

async function writeOkSentinel(metaDir: string): Promise<void> {
  const tmp = join(metaDir, ".ok.tmp");
  const final = join(metaDir, ".ok");
  await writeFile(tmp, "", "utf-8");
  await rename(tmp, final);
}
```

Replace `resolveRepo` with the full implementation (the URL branch; still partial — Task 6 adds cache-hit):

```ts
export async function resolveRepo(
  ref: RepoRef,
  opts: ResolveRepoOptions = {},
): Promise<ResolvedRepo> {
  if (ref.kind === "local") {
    const origin = await readOriginUrl(ref.path);
    if (origin === null) {
      return { ref, bareClonePath: ref.path, key: "local", fetched: false, stale: false };
    }
    return resolveRepo({ kind: "url", url: origin }, opts);
  }

  const cacheRoot = resolveCacheRoot({ env: process.env, home: process.env.HOME, override: opts.cacheRoot });
  const normalized = normalizeUrl(ref.url);
  const key = deriveCachePath(normalized);
  const cacheDir = join(cacheRoot, key);
  const metaDir = join(cacheDir, ".grove-cache");
  const locksDir = join(cacheRoot, ".locks");
  const lockFile = join(locksDir, `${encodeLockName(key)}.lock`);

  await mkdir(locksDir, { recursive: true });
  // proper-lockfile requires the target to exist
  if (!existsSync(lockFile)) await writeFile(lockFile, "", "utf-8");

  const release = await lockfile.lock(lockFile, { retries: { retries: 50, minTimeout: 50, maxTimeout: 500 } });
  try {
    const okPath = join(metaDir, ".ok");
    const okPresent = existsSync(okPath);

    if (!okPresent) {
      // Fresh clone (or recovery from a prior crash; Task 8 covers recovery branch).
      if (existsSync(cacheDir)) {
        await rm(cacheDir, { recursive: true, force: true });
      }
      await mkdir(cacheDir, { recursive: true });
      await runGit(["clone", "--bare", ref.url, cacheDir], { timeoutMs: opts.timeoutMs ?? 300_000 });
      await mkdir(metaDir, { recursive: true });
      const now = new Date().toISOString();
      const manifest: Manifest = {
        canonicalUrl: ref.url,
        aliases: [ref.url],
        createdAt: now,
        lastFetchedAt: now,
        lastAccessedAt: now,
      };
      await writeManifest(metaDir, manifest);
      await writeFile(join(metaDir, "last-fetch"), "", "utf-8");
      await writeOkSentinel(metaDir);
      return { ref, bareClonePath: cacheDir, key, fetched: true, stale: false };
    }

    // Cache-hit path fills in Task 6.
    throw new Error("resolveRepo: cache-hit path not yet implemented");
  } finally {
    await release();
  }
}
```

- [ ] **Step 5: Run tests**

Run: `bun test src/core/repo-cache.test.ts -t "fresh clone"`
Expected: PASS.

Run: `bun run typecheck` → no errors.
Run: `bun run check` → no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/repo-cache.ts src/core/repo-cache.test.ts
git commit -m "feat(repo-cache): fresh-clone path with lockfile + manifest + .ok sentinel"
```

---

## Task 6: `resolveRepo` — cache hit with TTL fetch

**Files:**
- Modify: `src/core/repo-cache.ts`
- Modify: `src/core/repo-cache.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/core/repo-cache.test.ts`:

```ts
import { utimesSync } from "node:fs";

describe("resolveRepo — cache hit", () => {
  test("second call within TTL does not fetch", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      const first = await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      expect(first.fetched).toBe(true);

      const second = await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      expect(second.fetched).toBe(false);
      expect(second.stale).toBe(false);
      expect(second.bareClonePath).toBe(first.bareClonePath);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("TTL expiry triggers fetch", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      const first = await resolveRepo(
        { kind: "url", url: `file://${fixture}` },
        { cacheRoot, fetchTtlMs: 0 },
      );
      expect(first.fetched).toBe(true);

      // Backdate last-fetch by 10s
      const lastFetch = join(first.bareClonePath, ".grove-cache", "last-fetch");
      const past = new Date(Date.now() - 10_000);
      utimesSync(lastFetch, past, past);

      const second = await resolveRepo(
        { kind: "url", url: `file://${fixture}` },
        { cacheRoot, fetchTtlMs: 1000 },
      );
      expect(second.fetched).toBe(true);
      expect(second.stale).toBe(false);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("appends new alias on URL-form change", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      await resolveRepo({ kind: "url", url: `file://${fixture}/` }, { cacheRoot }); // trailing slash → same key

      const manifestPath = join(cacheRoot, `local/${fixture.replace(/^\//, "")}.git`, ".grove-cache", "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(manifest.aliases).toContain(`file://${fixture}`);
      expect(manifest.aliases).toContain(`file://${fixture}/`);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/core/repo-cache.test.ts -t "cache hit"`
Expected: "cache-hit path not yet implemented".

- [ ] **Step 3: Implement the cache-hit branch**

In `src/core/repo-cache.ts`, replace the line
```ts
throw new Error("resolveRepo: cache-hit path not yet implemented");
```
with the full cache-hit logic:

```ts
// Cache hit. Update manifest (alias + lastAccessedAt).
const manifestPath = join(metaDir, "manifest.json");
const manifest: Manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
const now = new Date().toISOString();
manifest.lastAccessedAt = now;
if (!manifest.aliases.includes(ref.url)) manifest.aliases.push(ref.url);

const ttlMs = opts.fetchTtlMs ?? 60_000;
const lastFetchStat = await stat(join(metaDir, "last-fetch"));
const ageMs = Date.now() - lastFetchStat.mtimeMs;
const mustFetch = opts.fresh === true || ageMs > ttlMs;

let fetched = false;
let stale = false;

if (mustFetch) {
  try {
    await runGit(["fetch", "--all", "--prune"], {
      cwd: cacheDir,
      timeoutMs: opts.timeoutMs ?? 300_000,
    });
    const fetchTime = new Date();
    await writeFile(join(metaDir, "last-fetch"), "", "utf-8"); // ensure file exists
    utimes(join(metaDir, "last-fetch"), fetchTime, fetchTime);
    manifest.lastFetchedAt = fetchTime.toISOString();
    fetched = true;
  } catch (err) {
    if (opts.fresh === true) {
      await writeManifest(metaDir, manifest);
      throw new Error(`resolveRepo: --fresh fetch failed for ${ref.url}: ${(err as Error).message}`);
    }
    stale = true;
  }
}

await writeManifest(metaDir, manifest);
return { ref, bareClonePath: cacheDir, key, fetched, stale };
```

Add the `utimes` import:
```ts
import { utimes } from "node:fs/promises";
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/repo-cache.test.ts -t "cache hit"`
Expected: all three PASS.

Run: `bun test src/core/repo-cache.test.ts` (full file)
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/core/repo-cache.ts src/core/repo-cache.test.ts
git commit -m "feat(repo-cache): cache-hit path — TTL fetch, alias append, lastAccessed update"
```

---

## Task 7: `resolveRepo` — `--fresh` hard-fail on fetch failure

**Files:**
- Modify: `src/core/repo-cache.test.ts`

Implementation for this is already included in Task 6; this task is the explicit regression test for the `--fresh` hard-fail semantics (Q8-iii in the spec).

- [ ] **Step 1: Write failing test**

Append:

```ts
describe("resolveRepo — fresh hard-fail", () => {
  test("opts.fresh + unreachable remote throws", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      // Prime the cache against the fixture.
      await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      // Nuke the fixture so the next fetch fails.
      rmSync(fixture, { recursive: true, force: true });

      await expect(
        resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot, fresh: true }),
      ).rejects.toThrow(/--fresh fetch failed/);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("stale path (no --fresh) proceeds with stale=true when fetch fails", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      rmSync(fixture, { recursive: true, force: true });

      // Force fetch via fetchTtlMs:0 but without --fresh
      const result = await resolveRepo(
        { kind: "url", url: `file://${fixture}` },
        { cacheRoot, fetchTtlMs: 0 },
      );
      expect(result.stale).toBe(true);
      expect(result.fetched).toBe(false);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test src/core/repo-cache.test.ts -t "fresh hard-fail"`
Expected: PASS (Task 6 already implemented both branches).

- [ ] **Step 3: Commit**

```bash
git add src/core/repo-cache.test.ts
git commit -m "test(repo-cache): cover --fresh hard-fail + stale-on-fetch-failure semantics"
```

---

## Task 8: `resolveRepo` — corruption recovery (missing `.ok`)

**Files:**
- Modify: `src/core/repo-cache.test.ts`

The recovery logic is already in the clone branch of Task 5 (`if (existsSync(cacheDir)) { rm -rf … }`). This task is the explicit test.

- [ ] **Step 1: Write failing test**

Append:

```ts
describe("resolveRepo — corruption recovery", () => {
  test("absent .ok triggers nuke + re-clone", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      const first = await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      expect(first.fetched).toBe(true);

      // Simulate crash: remove .ok, leave garbage behind.
      rmSync(join(first.bareClonePath, ".grove-cache", ".ok"));
      writeFileSync(join(first.bareClonePath, "garbage"), "x");

      const second = await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      expect(second.fetched).toBe(true);
      expect(existsSync(join(second.bareClonePath, "garbage"))).toBe(false);
      expect(existsSync(join(second.bareClonePath, ".grove-cache", ".ok"))).toBe(true);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
```

Add import: `import { writeFileSync } from "node:fs";`

- [ ] **Step 2: Run tests**

Run: `bun test src/core/repo-cache.test.ts -t "corruption recovery"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/repo-cache.test.ts
git commit -m "test(repo-cache): cover .ok-absent corruption recovery"
```

---

## Task 9: `resolveRepo` — timeout kills subprocess

**Files:**
- Modify: `src/core/repo-cache.test.ts`

- [ ] **Step 1: Write failing test**

Append:

```ts
describe("resolveRepo — timeout", () => {
  test("clone timeout throws and leaves the entry recoverable", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      // Use a non-existent remote to force a slow git failure; 1ms timeout ensures abort.
      await expect(
        resolveRepo(
          { kind: "url", url: "https://example.invalid/does/not/exist" },
          { cacheRoot, timeoutMs: 1 },
        ),
      ).rejects.toBeDefined();

      // Next call (with a working fixture) must still succeed — the failed
      // cacheDir must either not exist or be recoverable.
      const fixture = makeFixtureRepo();
      try {
        // Different URL → different cache entry; just prove the cache root itself is usable.
        const result = await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
        expect(result.fetched).toBe(true);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test src/core/repo-cache.test.ts -t "timeout"`
Expected: PASS (implementation already wires `AbortController` via `runGit`).

- [ ] **Step 3: Commit**

```bash
git add src/core/repo-cache.test.ts
git commit -m "test(repo-cache): cover clone timeout + subsequent recovery"
```

---

## Task 10: `resolveRepo` — concurrent callers serialize

**Files:**
- Modify: `src/core/repo-cache.test.ts`

- [ ] **Step 1: Write failing test**

Append:

```ts
describe("resolveRepo — concurrency", () => {
  test("five concurrent callers produce one clone + four hits", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot }),
        ),
      );
      const fetched = results.filter((r) => r.fetched).length;
      expect(fetched).toBe(1);
      for (const r of results) {
        expect(r.bareClonePath).toBe(results[0]!.bareClonePath);
      }
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test src/core/repo-cache.test.ts -t concurrency`
Expected: PASS — lockfile serializes the callers; only the first sees `fetched=true`.

- [ ] **Step 3: Commit**

```bash
git add src/core/repo-cache.test.ts
git commit -m "test(repo-cache): assert concurrent resolveRepo calls serialize via lockfile"
```

---

## Task 11: `resolveRepo` — local path with origin resolves through cache

**Files:**
- Modify: `src/core/repo-cache.test.ts`

Implementation already done in Task 4 (the `origin !== null` branch delegates to the URL path). This task is the explicit test.

- [ ] **Step 1: Write failing test**

Append:

```ts
describe("resolveRepo — local with origin", () => {
  test("reads origin and caches via URL path", async () => {
    const fixture = makeFixtureRepo();
    const workTree = mkdtempSync(join(tmpdir(), "grove-rc-wt-"));
    execSync(`git clone "${fixture}" "${workTree}"`, { stdio: "pipe" });

    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      const result = await resolveRepo({ kind: "local", path: workTree }, { cacheRoot });
      expect(result.fetched).toBe(true);
      expect(result.bareClonePath).not.toBe(workTree);
      expect(result.bareClonePath.startsWith(cacheRoot)).toBe(true);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(workTree, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test src/core/repo-cache.test.ts -t "local with origin"`
Expected: PASS.

Run: `bun test src/core/repo-cache.test.ts` (full)
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/core/repo-cache.test.ts
git commit -m "test(repo-cache): local path with origin is cached via URL"
```

---

## Task 12: `workspace-provisioner.ts` — `repoRoot` → `bareClonePath`

**Files:**
- Modify: `src/core/workspace-provisioner.ts`
- Modify: `src/core/workspace-provisioner.test.ts`

Scope: rename exactly one field on `WorkspaceProvisionOptions` and the three-arg positional form; update `cleanupSessionWorkspaces` similarly; update all callers' tests to pass a real bare clone fixture.

- [ ] **Step 1: Update tests to pass `bareClonePath` from a fixture bare clone**

Replace `beforeEach` in `src/core/workspace-provisioner.test.ts`:

```ts
  beforeEach(() => {
    // Create a bare clone with a seeded initial commit — matches the new
    // workspace-provisioner contract (worktrees are added from a bare clone).
    repoDir = mkdtempSync(join(tmpdir(), "grove-wp-bare-"));
    execSync("git init --bare", { cwd: repoDir, stdio: "pipe" });

    const scratch = mkdtempSync(join(tmpdir(), "grove-wp-scratch-"));
    execSync(`git clone "${repoDir}" "${scratch}"`, { stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: scratch, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: scratch, stdio: "pipe" });
    execSync("git commit --allow-empty -m 'init'", { cwd: scratch, stdio: "pipe" });
    execSync("git branch -M main", { cwd: scratch, stdio: "pipe" });
    execSync("git push origin main", { cwd: scratch, stdio: "pipe" });
    rmSync(scratch, { recursive: true, force: true });

    baseDir = join(tmpdir(), `grove-wp-base-${Date.now()}`);
  });
```

Rename every `repoRoot:` call-site in this file to `bareClonePath:`. In the "baseBranch" test, replace the `git checkout -b feature-base` block with operations performed in a scratch clone (bare repos can't check out):

```ts
  test("provisionWorkspace respects baseBranch option", async () => {
    // Create a scratch clone to produce a second branch, then push it to the bare.
    const scratch = mkdtempSync(join(tmpdir(), "grove-wp-scratch2-"));
    execSync(`git clone "${repoDir}" "${scratch}"`, { stdio: "pipe" });
    execSync('git config user.email "t@t"', { cwd: scratch, stdio: "pipe" });
    execSync('git config user.name "t"', { cwd: scratch, stdio: "pipe" });
    execSync("git checkout -b feature-base", { cwd: scratch, stdio: "pipe" });
    execSync("git commit --allow-empty -m 'feature commit'", { cwd: scratch, stdio: "pipe" });
    execSync("git push origin feature-base", { cwd: scratch, stdio: "pipe" });
    rmSync(scratch, { recursive: true, force: true });

    const result = await provisionWorkspace({
      role: "tester",
      sessionId: "base-branch-session",
      baseDir,
      bareClonePath: repoDir,
      baseBranch: "feature-base",
    });

    expect(existsSync(result.path)).toBe(true);
    const log = execSync("git log --oneline", { cwd: result.path, encoding: "utf-8" });
    expect(log).toContain("feature commit");
  });
```

Update the "errors gracefully" test — `bareClonePath: "/nonexistent/repo/path"` (same behavior; field name only).

The `afterEach` worktree-listing block uses the bare clone directly, which supports `git worktree list --porcelain` — no change required.

- [ ] **Step 2: Run tests — expect failure**

Run: `bun test src/core/workspace-provisioner.test.ts`
Expected: compile error / field-not-found.

- [ ] **Step 3: Update `src/core/workspace-provisioner.ts`**

Replace `repoRoot` with `bareClonePath` in four places:
- `WorkspaceProvisionOptions` interface (line ~46)
- Destructuring in `provisionWorkspace` (line ~92)
- `cwd: repoRoot` → `cwd: bareClonePath` in `execFileAsync` (line ~104)
- `provisionSessionWorkspaces` signature + forwarding (lines ~125, ~138)
- `cleanupSessionWorkspaces` signature + both `cwd` sites (lines ~174, ~179, ~185)

Also update the JSDoc comment at the top of `provisionWorkspace` to say "from a bare clone" instead of "from the source repo".

- [ ] **Step 4: Run tests**

Run: `bun test src/core/workspace-provisioner.test.ts`
Expected: all green.

Run: `bun run typecheck`
Expected: failures in every caller that still passes `repoRoot`. **Those callers are updated in Tasks 13–14** — this is expected, do NOT fix them here.

Run: `bun test src/core/workspace-provisioner.test.ts`
Expected: provisioner's own tests still green.

- [ ] **Step 5: Commit** (deferred — commit together with caller fixes in Task 14)

---

## Task 13: `session-orchestrator.ts` — add `repos` + `repoCache`

**Files:**
- Modify: `src/core/session-orchestrator.ts`
- Modify: `src/core/session-orchestrator.test.ts`

- [ ] **Step 1: Update `SessionOrchestratorConfig`**

In `src/core/session-orchestrator.ts` near line 44, replace the block:

```ts
  /** Working directory for the project. */
  readonly projectRoot: string;
```

with:

```ts
  /**
   * Grove launcher directory — anchors `.grove/`, `mcpServePath`, the
   * bundled skills root, workspace-override skills root, and fallback
   * cwd when no workspace is provisioned. Independent of `repos`.
   */
  readonly projectRoot: string;

  /**
   * Repositories the session targets. Length ≥ 1; today exactly 1 is
   * honored (the forward-compat hook for multi-repo sessions).
   * Resolved to bare clones via `resolveRepo` at session start.
   */
  readonly repos: readonly RepoRef[];

  /** Overrides for cache resolution (tests, CI, explicit cache root). */
  readonly repoCache?: Partial<ResolveRepoOptions>;
```

Add imports at the top:
```ts
import type { RepoRef } from "./repo-ref.js";
import { resolveRepo, type ResolveRepoOptions, type ResolvedRepo } from "./repo-cache.js";
```

- [ ] **Step 2: Resolve repos once at session start**

Add a private field to the class:

```ts
  private resolvedRepos: readonly ResolvedRepo[] = [];
```

Add a lazy one-time resolve helper:

```ts
  private async ensureReposResolved(): Promise<void> {
    if (this.resolvedRepos.length > 0) return;
    if (this.config.repos.length > 1) {
      throw new Error(
        "SessionOrchestrator: multi-repo sessions are not yet supported; pass exactly one repo.",
      );
    }
    this.resolvedRepos = await Promise.all(
      this.config.repos.map((ref) => resolveRepo(ref, this.config.repoCache ?? {})),
    );
  }
```

Call `await this.ensureReposResolved()` at the top of the method that currently passes `repoRoot` to `provisionWorkspace` (line ~457 region). Replace:

```ts
        repoRoot: this.config.projectRoot,
```

with:

```ts
        bareClonePath: this.resolvedRepos[0]!.bareClonePath,
```

Leave every other `this.config.projectRoot` reference untouched — those are launcher-dir uses.

- [ ] **Step 3: Update `session-orchestrator.test.ts` to supply `repos`**

Every `SessionOrchestrator` construction site in the test file must gain `repos: [{ kind: "local", path: fixtureBarePath }]`. Use a `makeFixtureBareRepo` helper (reuse the shape from Task 5's `makeFixtureRepo`). Where the test previously pointed `projectRoot` at a working repo for provisioning, now:

- `projectRoot` stays set to a temp directory used for `.grove/` plumbing.
- `repos[0]` is `{ kind: "local", path: bare }` where `bare` is a freshly created bare clone.

- [ ] **Step 4: Run tests**

Run: `bun test src/core/session-orchestrator.test.ts`
Expected: all green (once the tests are updated).

Run: `bun run typecheck`
Expected: remaining errors only in `spawn-manager.ts` and CLI (handled in Task 14).

- [ ] **Step 5: Commit** (deferred — pair with Task 14)

---

## Task 14: `spawn-manager.ts` — add `repos` + `repoCache`; commit the cutover

**Files:**
- Modify: `src/tui/spawn-manager.ts`
- Modify: `src/tui/spawn-manager.test.ts`

- [ ] **Step 1: Update `SpawnManager` construction**

Mirror Task 13 precisely: add `repos: readonly RepoRef[]` + `repoCache?: Partial<ResolveRepoOptions>` to the options interface; add `resolvedRepos` + `ensureReposResolved()` (same body, same multi-repo guard).

At the `provisionWorkspace` call site (around line 475 of `src/tui/spawn-manager.ts`), add `await this.ensureReposResolved()` just before the call and replace:

```ts
        repoRoot: projectRoot,
```

with:

```ts
        bareClonePath: this.resolvedRepos[0]!.bareClonePath,
```

Keep every `projectRoot`/`groveDir` reference used for `.grove/`, `mcpServePath`, bundled skills, and fallback cwd unchanged.

- [ ] **Step 2: Update `spawn-manager.test.ts`**

Same shape as Task 13 step 3 — every SpawnManager construction gains `repos: [{ kind: "local", path: bareFixturePath }]`.

- [ ] **Step 3: Run full suite**

Run: `bun run typecheck`
Expected: clean.

Run: `bun test`
Expected: all green.

Run: `bun run check`
Expected: clean.

- [ ] **Step 4: Commit the whole cutover** (Tasks 12 + 13 + 14 together)

```bash
git add \
  src/core/workspace-provisioner.ts \
  src/core/workspace-provisioner.test.ts \
  src/core/session-orchestrator.ts \
  src/core/session-orchestrator.test.ts \
  src/tui/spawn-manager.ts \
  src/tui/spawn-manager.test.ts
git commit -m "feat(workspace): route workspace provisioning through repo-cache bareClonePath"
```

---

## Task 15: `AgentRole.repoIndex?: number`

Forward-compat field for the future multi-repo sub-spec. Defaults to 0; unused today.

**Files:**
- Modify: `src/core/topology.ts`
- Modify: `src/core/topology.test.ts`

- [ ] **Step 1: Write failing test**

Append to `src/core/topology.test.ts`:

```ts
test("AgentRole accepts repoIndex; defaults to undefined; parses across the wire", () => {
  // Build the minimal wire shape the codebase already uses for AgentRole and
  // assert repoIndex round-trips. Adapt the wire object to match existing
  // examples in this test file (copy the closest neighbor test).
  const parsed = AgentRoleSchema.parse({
    name: "coder",
    repoIndex: 0,
    // ...other required fields per existing schema shape
  });
  expect(parsed.repoIndex).toBe(0);
});
```

(Implementer: copy the exact neighbor test's required-field set — don't guess at the full shape; the schema evolves.)

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/core/topology.test.ts -t "repoIndex"`
Expected: schema rejects unknown field, or field absent.

- [ ] **Step 3: Add the field**

In `src/core/topology.ts`, find the `AgentRoleSchema` (or equivalent) and add:

```ts
  repoIndex: z.number().int().nonnegative().optional(),
```

Also extend the `AgentRole` TypeScript interface to include `readonly repoIndex?: number;`.

- [ ] **Step 4: Run tests**

Run: `bun test src/core/topology.test.ts`
Expected: green.

Run: `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/topology.ts src/core/topology.test.ts
git commit -m "feat(topology): AgentRole.repoIndex forward-compat field for multi-repo sessions"
```

---

## Task 16: CLI `--repo` flag + cwd default

**Files:**
- Modify: `src/cli/commands/up.ts` (and any sibling command that constructs a session config; `rg --files-with-matches "projectRoot"` in `src/cli/` gives the list)

- [ ] **Step 1: Find CLI entry points that construct session config**

Run:
```bash
rg --files-with-matches "SessionOrchestratorConfig|SpawnManagerOptions|projectRoot" src/cli
```

The implementer applies steps 2–4 to each one. The concrete file names are the ones that come back from that `rg`.

- [ ] **Step 2: Write failing CLI test**

In the test file for the command (same directory), add:

```ts
test("--repo is accepted, parses as RepoRef", async () => {
  const result = await parseUpCommandArgs(["--repo", "https://github.com/foo/bar"]);
  expect(result.repos).toEqual([{ kind: "url", url: "https://github.com/foo/bar" }]);
});

test("passing two --repo values fails with multi-repo not supported", async () => {
  await expect(
    parseUpCommandArgs(["--repo", "https://github.com/foo/bar", "--repo", "https://github.com/baz/qux"]),
  ).rejects.toThrow(/multi-repo sessions/);
});

test("no --repo defaults to cwd as local RepoRef", async () => {
  const result = await parseUpCommandArgs([], { cwd: "/abs/cwd" });
  expect(result.repos).toEqual([{ kind: "local", path: "/abs/cwd" }]);
});

test("no --repo + cwd not in a git repo throws actionable error", async () => {
  const result = parseUpCommandArgs([], { cwd: "/abs/not-a-repo", isGitRepo: () => false });
  await expect(result).rejects.toThrow(/run grove from inside a git repo/);
});
```

(Implementer: `parseUpCommandArgs` is the factoring you introduce — see step 3. Name mirrors existing parser helpers; if a different name is idiomatic in this repo, match it.)

- [ ] **Step 3: Wire the flag**

Add to the command's flag schema:

```ts
const flags = {
  repo: { type: "string", multiple: true, description: "Repository URL or local path; passed through to resolveRepo" },
  ...existing,
} as const;
```

In the command body, after parsing:

```ts
function buildRepos(rawRepo: readonly string[], cwd: string, isGitRepo: (p: string) => boolean): readonly RepoRef[] {
  if (rawRepo.length > 1) {
    throw new Error(
      "multi-repo sessions are not yet supported (see sub-spec for #202). " +
      "Pass at most one --repo.",
    );
  }
  if (rawRepo.length === 1) {
    const raw = rawRepo[0]!;
    if (raw.startsWith("/") || raw.startsWith(".")) {
      return [{ kind: "local", path: raw }];
    }
    return [{ kind: "url", url: raw }];
  }
  if (!isGitRepo(cwd)) {
    throw new Error("run grove from inside a git repo, or pass --repo <url>");
  }
  return [{ kind: "local", path: cwd }];
}
```

Pass the resulting `repos` into `SessionOrchestratorConfig`/`SpawnManagerOptions`.

- [ ] **Step 4: Run tests**

Run: `bun test <command-test-file>`
Expected: green.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli
git commit -m "feat(cli): --repo flag; default to cwd; reject >1 repo until multi-repo ships"
```

---

## Task 17: `grove repo list` + `grove repo prune` + `grove repo fetch`

**Files:**
- Create: `src/cli/commands/repo.ts`
- Create: `src/cli/commands/repo.test.ts`
- Modify: `src/cli/main.ts` (register subcommand)

- [ ] **Step 1: Write failing tests**

Create `src/cli/commands/repo.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCache, pruneCache, fetchCache } from "./repo.js";
import { resolveRepo } from "../../core/repo-cache.js";

function makeFixtureBare(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-repo-fx-"));
  execSync("git init --bare", { cwd: dir, stdio: "pipe" });
  const scratch = mkdtempSync(join(tmpdir(), "grove-repo-scratch-"));
  execSync(`git clone "${dir}" "${scratch}"`, { stdio: "pipe" });
  execSync('git config user.email "t@t"', { cwd: scratch, stdio: "pipe" });
  execSync('git config user.name "t"', { cwd: scratch, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: scratch, stdio: "pipe" });
  execSync("git branch -M main", { cwd: scratch, stdio: "pipe" });
  execSync("git push origin main", { cwd: scratch, stdio: "pipe" });
  rmSync(scratch, { recursive: true, force: true });
  return dir;
}

describe("grove repo CLI", () => {
  let cacheRoot: string;
  let fixtures: string[] = [];

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "grove-repo-cli-"));
    fixtures = [];
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
    for (const f of fixtures) rmSync(f, { recursive: true, force: true });
  });

  test("list returns zero entries on empty cache", async () => {
    const entries = await listCache({ cacheRoot });
    expect(entries).toEqual([]);
  });

  test("list returns entries after a resolve", async () => {
    const f = makeFixtureBare();
    fixtures.push(f);
    await resolveRepo({ kind: "url", url: `file://${f}` }, { cacheRoot });

    const entries = await listCache({ cacheRoot });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.canonicalUrl).toBe(`file://${f}`);
    expect(entries[0]!.key).toBe(`local/${f.replace(/^\//, "")}.git`);
  });

  test("prune removes a specific entry", async () => {
    const f = makeFixtureBare();
    fixtures.push(f);
    const resolved = await resolveRepo({ kind: "url", url: `file://${f}` }, { cacheRoot });

    await pruneCache({ cacheRoot, key: resolved.key });
    expect(existsSync(resolved.bareClonePath)).toBe(false);
  });

  test("prune --all removes every entry", async () => {
    const f1 = makeFixtureBare();
    const f2 = makeFixtureBare();
    fixtures.push(f1, f2);
    await resolveRepo({ kind: "url", url: `file://${f1}` }, { cacheRoot });
    await resolveRepo({ kind: "url", url: `file://${f2}` }, { cacheRoot });

    await pruneCache({ cacheRoot, all: true });
    const entries = await listCache({ cacheRoot });
    expect(entries).toEqual([]);
  });

  test("prune refuses when a worktree still references the entry", async () => {
    const f = makeFixtureBare();
    fixtures.push(f);
    const resolved = await resolveRepo({ kind: "url", url: `file://${f}` }, { cacheRoot });
    const wt = mkdtempSync(join(tmpdir(), "grove-repo-wt-"));
    try {
      execSync(`git -C "${resolved.bareClonePath}" worktree add "${wt}"`, { stdio: "pipe" });
      await expect(pruneCache({ cacheRoot, key: resolved.key })).rejects.toThrow(/worktree/);
      expect(existsSync(resolved.bareClonePath)).toBe(true);
    } finally {
      execSync(`git -C "${resolved.bareClonePath}" worktree remove --force "${wt}"`, { stdio: "pipe" });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("fetch forces a fetch on the cache entry", async () => {
    const f = makeFixtureBare();
    fixtures.push(f);
    const resolved = await resolveRepo({ kind: "url", url: `file://${f}` }, { cacheRoot });

    const result = await fetchCache({ cacheRoot, key: resolved.key });
    expect(result.fetched).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/cli/commands/repo.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/cli/commands/repo.ts`**

```ts
/**
 * `grove repo` subcommands — inspect and maintain the bare-clone cache.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveRepo, type ResolveRepoOptions } from "../../core/repo-cache.js";

const execFileAsync = promisify(execFile);

export interface CacheEntry {
  readonly key: string;
  readonly bareClonePath: string;
  readonly canonicalUrl: string;
  readonly aliases: readonly string[];
  readonly createdAt: string;
  readonly lastFetchedAt: string;
  readonly lastAccessedAt: string;
}

async function walkEntries(cacheRoot: string): Promise<CacheEntry[]> {
  if (!existsSync(cacheRoot)) return [];
  const entries: CacheEntry[] = [];

  async function recurse(dir: string, relParts: string[]): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (item.name === ".locks") continue;
      const child = join(dir, item.name);
      if (item.name.endsWith(".git")) {
        const manifestPath = join(child, ".grove-cache", "manifest.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
        entries.push({
          key: [...relParts, item.name].join("/"),
          bareClonePath: child,
          canonicalUrl: manifest.canonicalUrl,
          aliases: manifest.aliases,
          createdAt: manifest.createdAt,
          lastFetchedAt: manifest.lastFetchedAt,
          lastAccessedAt: manifest.lastAccessedAt,
        });
      } else {
        await recurse(child, [...relParts, item.name]);
      }
    }
  }

  await recurse(cacheRoot, []);
  return entries;
}

export async function listCache(opts: { cacheRoot: string }): Promise<CacheEntry[]> {
  return walkEntries(opts.cacheRoot);
}

export async function pruneCache(
  opts: { cacheRoot: string; key?: string; all?: boolean },
): Promise<void> {
  const entries = await walkEntries(opts.cacheRoot);
  const targets = opts.all ? entries : entries.filter((e) => e.key === opts.key);

  if (!opts.all && targets.length === 0) {
    throw new Error(`no cache entry matches key: ${opts.key}`);
  }

  for (const entry of targets) {
    // Worktree safety check: each worktree line starting with "worktree "
    // other than the bare clone itself is an external checkout we must not strand.
    const { stdout } = await execFileAsync("git", ["-C", entry.bareClonePath, "worktree", "list", "--porcelain"]);
    const external = stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.replace(/^worktree /, ""))
      .filter((p) => p !== entry.bareClonePath);
    if (external.length > 0) {
      throw new Error(
        `cannot prune ${entry.key}: ${external.length} worktree(s) still reference it:\n${external.join("\n")}`,
      );
    }
    await rm(entry.bareClonePath, { recursive: true, force: true });
  }

  // Best-effort: remove the matching lockfile(s) too.
  const locksDir = join(opts.cacheRoot, ".locks");
  if (existsSync(locksDir)) {
    for (const entry of targets) {
      const lockFile = join(locksDir, `${entry.key.replace(/\//g, "__")}.lock`);
      if (existsSync(lockFile)) await rm(lockFile, { force: true });
    }
  }
}

export async function fetchCache(
  opts: { cacheRoot: string; key: string; resolveOpts?: Partial<ResolveRepoOptions> },
): Promise<{ fetched: boolean; stale: boolean }> {
  const entries = await walkEntries(opts.cacheRoot);
  const entry = entries.find((e) => e.key === opts.key);
  if (!entry) throw new Error(`no cache entry matches key: ${opts.key}`);
  const result = await resolveRepo(
    { kind: "url", url: entry.canonicalUrl },
    { ...(opts.resolveOpts ?? {}), cacheRoot: opts.cacheRoot, fresh: true },
  );
  return { fetched: result.fetched, stale: result.stale };
}
```

- [ ] **Step 4: Register the subcommand**

In `src/cli/main.ts`, add a branch for `repo` that dispatches to `list` / `prune` / `fetch`. Surface one-line human-readable output for `list` and `prune` (manifest summary / success message); the programmatic shapes above are what tests consume.

- [ ] **Step 5: Run tests**

Run: `bun test src/cli/commands/repo.test.ts`
Expected: all green.

Run: `bun run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/repo.ts src/cli/commands/repo.test.ts src/cli/main.ts
git commit -m "feat(cli): grove repo list/prune/fetch for cache inspection and maintenance"
```

---

## Task 18: End-to-end — session against a bare-clone fixture

**Files:**
- Create: `tests/e2e/repo-cache-session.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionWorkspace } from "../../src/core/workspace-provisioner.js";
import { resolveRepo } from "../../src/core/repo-cache.js";

let fixture: string;
let cacheRoot: string;
let groveDir: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "grove-e2e-fx-"));
  execSync("git init --bare", { cwd: fixture, stdio: "pipe" });
  const scratch = mkdtempSync(join(tmpdir(), "grove-e2e-scratch-"));
  execSync(`git clone "${fixture}" "${scratch}"`, { stdio: "pipe" });
  execSync('git config user.email "t@t"', { cwd: scratch, stdio: "pipe" });
  execSync('git config user.name "t"', { cwd: scratch, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: scratch, stdio: "pipe" });
  execSync("git branch -M main", { cwd: scratch, stdio: "pipe" });
  execSync("git push origin main", { cwd: scratch, stdio: "pipe" });
  rmSync(scratch, { recursive: true, force: true });

  cacheRoot = mkdtempSync(join(tmpdir(), "grove-e2e-cache-"));
  groveDir = mkdtempSync(join(tmpdir(), "grove-e2e-dir-"));
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
  rmSync(cacheRoot, { recursive: true, force: true });
  rmSync(groveDir, { recursive: true, force: true });
});

test("resolve → provision → commit flow against a bare-clone fixture", async () => {
  const resolved = await resolveRepo(
    { kind: "url", url: `file://${fixture}` },
    { cacheRoot },
  );

  const ws = await provisionWorkspace({
    role: "coder",
    sessionId: "e2esess00000000",
    baseDir: join(groveDir, "workspaces"),
    bareClonePath: resolved.bareClonePath,
  });

  // Agent can edit + commit + push back to the bare clone.
  execSync(`bash -c 'echo "hello" > ${ws.path}/hello.txt'`, { stdio: "pipe" });
  execSync('git config user.email "agent@t"', { cwd: ws.path, stdio: "pipe" });
  execSync('git config user.name "agent"', { cwd: ws.path, stdio: "pipe" });
  execSync("git add hello.txt && git commit -m 'add hello'", { cwd: ws.path, stdio: "pipe" });
  execSync(`git push origin ${ws.branch}`, { cwd: ws.path, stdio: "pipe" });

  // Branch landed in the bare clone.
  const branches = execSync(`git -C "${resolved.bareClonePath}" branch`, { encoding: "utf-8" });
  expect(branches).toContain(ws.branch);
  expect(existsSync(join(ws.path, "hello.txt"))).toBe(true);
});
```

- [ ] **Step 2: Run**

Run: `bun test tests/e2e/repo-cache-session.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/repo-cache-session.test.ts
git commit -m "test(e2e): resolveRepo → provisionWorkspace → commit flow"
```

---

## Task 19: Documentation

**Files:**
- Modify: `README.md`
- Modify: `QUICKSTART.md`
- Modify: `GROVE.md`

- [ ] **Step 1: README — add a "Repo cache" section**

Append under an appropriate top-level heading (e.g., after "Configuration"):

```markdown
## Repo cache

Grove uses a user-wide bare-clone cache so that agent worktrees are
cheap regardless of whether you've checked out the repo locally.

**Cache location** (first match wins):
1. `$GROVE_REPO_CACHE`
2. Grove config file `repoCache.path`
3. `$XDG_CACHE_HOME/grove/repo-cache/`
4. `~/.cache/grove/repo-cache/`

**Maintenance:**
- `grove repo list` — show every cached repo + when it was last fetched.
- `grove repo prune <key>` — remove one entry (refuses if a worktree still references it).
- `grove repo prune --all` — remove every entry.
- `grove repo fetch <key>` — force a fetch on an existing entry.

Cache growth is unbounded by design — grove never evicts without being
told. Run `grove repo prune --all` if disk pressure bites.
```

- [ ] **Step 2: QUICKSTART — document the `--repo` flag**

Add (near the first `grove up`/`grove session start` example):

```markdown
### Pointing at a specific repo

By default grove uses the git repo your shell is currently in. To target
a different repo — checked out locally or not — pass `--repo`:

    grove up --repo https://github.com/you/project
    grove up --repo /abs/path/to/checkout

Only one `--repo` is accepted today; multi-repo sessions ship in a
later release.
```

- [ ] **Step 3: GROVE.md — cross-reference**

Add a one-liner pointing at the README section so agents reading GROVE.md discover the cache:

```markdown
## Repo cache

Agent worktrees come from a shared bare-clone cache (`$XDG_CACHE_HOME/grove/repo-cache/`).
See `README.md` → "Repo cache" for maintenance commands.
```

- [ ] **Step 4: Commit**

```bash
git add README.md QUICKSTART.md GROVE.md
git commit -m "docs: document repo cache location, --repo flag, grove repo commands"
```

---

## Task 20: Close the loop

- [ ] **Step 1: Full suite**

Run: `bun run typecheck && bun run check && bun test`
Expected: all green.

- [ ] **Step 2: Update issue**

Post a comment on #263 linking the spec + plan and summarizing the PR chain. (Do not close yet — the issue closes when the PR merges.)

```bash
gh issue comment 263 --body "$(cat <<'EOF'
Spec + plan landed on this worktree.

- Spec: `docs/superpowers/specs/2026-04-21-bare-clone-repo-cache-design.md`
- Plan: `docs/superpowers/plans/2026-04-21-bare-clone-repo-cache.md`

20 tasks, TDD throughout, no feature flag. Ready for implementation.
EOF
)"
```

- [ ] **Step 3: Final commit if anything drifted**

```bash
git status
# If any unstaged doc tweaks remain, commit with message:
# "docs: tidy repo-cache docs after final review"
```

---

## Self-Review Notes

- **Spec coverage.** Every section of the spec maps to a task:
  - Types + normalization + cache key → Task 2.
  - On-disk layout (lockfile outside entry, `.ok`, manifest) → Tasks 5, 8.
  - `resolveRepo` flow (clone, cache hit, TTL, fresh, offline, recovery, timeout) → Tasks 5–9.
  - Concurrency → Task 10.
  - Local path with/without origin → Tasks 4, 11.
  - Provisioner signature change → Task 12.
  - Session config / SpawnManager changes → Tasks 13, 14.
  - `AgentRole.repoIndex` → Task 15.
  - CLI `--repo` (with multi-repo rejection + cwd default + not-in-repo error) → Task 16.
  - `grove repo list/prune/fetch` → Task 17.
  - E2E test → Task 18.
  - Docs → Task 19.
- **Placeholder scan.** None. Task 15 points the implementer at the neighbor schema test rather than guessing schema shape — justified because the wire schema evolves. Task 16 step 1 uses `rg` to discover entry points — justified because the codebase has multiple session-starting commands today. Both are instructions, not TODOs.
- **Type consistency.** `RepoRef`, `ResolveRepoOptions`, `ResolvedRepo` spelled consistently across all tasks. `bareClonePath` (not `bare_clone_path`, `clonePath`, etc.) is the single field name used everywhere.
- **Scope.** One subsystem (the cache + its consumers). No unrelated refactors. `projectRoot` stays exactly where it was.
