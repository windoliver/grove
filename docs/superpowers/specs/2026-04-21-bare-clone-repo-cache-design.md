# Bare-Clone Repo Cache — Design

- **Date:** 2026-04-21
- **Issue:** [#263](https://github.com/windoliver/grove/issues/263) (sub-spec 3 of [#202](https://github.com/windoliver/grove/issues/202))
- **Status:** Draft for review

## Summary

Grove materializes each agent role's workspace by running `git worktree add` from `projectRoot`, a single local checkout of the session's repo. This assumes every session runs against one already-cloned local repo and re-pays disk cost for every worktree.

This spec adds a **user-wide bare-clone cache**. A session targets one or more `RepoRef`s (local path or URL); Grove resolves each to a bare clone in a shared cache directory; worktrees for agent tasks are created from the cache. The cache is locked for safe concurrent access, fetches are TTL-gated, and corruption recovers automatically.

## Goals

- Sessions can target arbitrary git repos by URL, not just `process.cwd()`.
- A single bare clone per normalized repo URL, shared across all grove sessions on the machine.
- Worktree creation is cheap regardless of whether the repo was ever locally checked out.
- Concurrent grove processes on one machine cooperate safely on the same cache entry.
- Forward-compatible with multi-repo sessions (where different roles use different repos) without a second breaking change.
- Offline and flaky-network tolerance as a first-class concern.

## Non-goals

- Multi-repo sessions — API surface ships now (`repos: RepoRef[]`, `AgentRole.repoIndex?`), semantics land in a later sub-spec.
- Automatic LRU or age-based eviction — v1 is unbounded with `grove repo prune`.
- Credential management beyond inheriting git's config.
- Hot-swap a role's repo mid-session.
- Nexus-hosted repo cache shared across machines.
- Submodules, LFS, partial-clone tuning, shallow clones — callers configure `git` itself if they need these.

## Background

### Current state

- `src/core/workspace-provisioner.ts` — `provisionWorkspace({ repoRoot, ... })` runs `git worktree add <path> -b <branch> <base>` with `cwd: repoRoot`. `repoRoot` is the session's one local checkout.
- `src/core/session-orchestrator.ts` — `SessionOrchestratorConfig.projectRoot: string` is used both as `cwd` for shell-outs and as `repoRoot` for the provisioner.
- `src/tui/spawn-manager.ts` — derives `projectRoot = resolve(groveDir, "..")` and passes that to the provisioner.
- No bare-clone or cache code anywhere in the repo (`rg 'bare.clone|repo-cache|repoCache|--bare'` finds no hits).

### Gap

- Sessions cannot target a repo that is not already locally checked out.
- N roles in a session → N worktrees off one checkout; the shared `.git` is already deduped by git, but the "single checkout" coupling blocks the multi-repo and external-repo cases entirely.
- No path for CI/containers to pre-seed a cache volume.

## Design

### Architecture

Three modules, clear boundaries:

```
src/core/
  repo-ref.ts          # RepoRef type, URL normalization, cache-key derivation
  repo-cache.ts        # resolveRepo(repoRef, opts) → { bareClonePath, fetched, stale }
  workspace-provisioner.ts  # consumes bareClonePath instead of repoRoot
```

- `repo-ref.ts` — pure functions: `normalizeUrl()`, `deriveCachePath()`, `RepoRef` discriminated union. No I/O.
- `repo-cache.ts` — side-effectful: owns the cache directory, runs `git clone --bare`/`git fetch`, holds locks, maintains sentinel and manifest files. One public function: `resolveRepo`. Knows nothing about agents, roles, or worktrees.
- `workspace-provisioner.ts` — unchanged behavior except that `cwd` for `git worktree add` is the bare-clone path returned by `resolveRepo`.

Session-level callers (`SpawnManager`, `SessionOrchestrator`) resolve the session's `repos: RepoRef[]` once at session start and cache the result on the session object; the cache layer is not touched in per-role hot paths.

No Nexus coupling. The cache is a local filesystem concern; multiple grove processes on the same machine cooperate via `flock()` on per-entry lockfiles.

### Types

```ts
export type RepoRef =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "url";   readonly url: string; readonly ref?: string };

export interface ResolveRepoOptions {
  readonly fresh?: boolean;        // force fetch regardless of TTL
  readonly cacheRoot?: string;     // override cache root (testing, CI)
  readonly fetchTtlMs?: number;    // default 60_000
  readonly timeoutMs?: number;     // clone/fetch hard timeout (default 300_000)
}

export interface ResolvedRepo {
  readonly ref: RepoRef;
  readonly bareClonePath: string;  // absolute; safe cwd for `git worktree add`
  readonly key: string;            // e.g. "github.com/foo/bar.git"
  readonly fetched: boolean;       // did this call run a fetch
  readonly stale: boolean;         // true if fetch failed but cache was usable
}

export async function resolveRepo(
  ref: RepoRef,
  opts?: ResolveRepoOptions,
): Promise<ResolvedRepo>;
```

`RepoRef.ref` (branch/tag/commit) is parsed and passed through as the `baseBranch` hint to `provisionWorkspace`; it is **not** consulted when deriving the cache key (one cache entry per repo URL, not per ref).

### URL normalization + cache key

```
normalizeUrl(raw) → { host, path }

  "git@github.com:foo/bar.git"      → { host: "github.com",   path: "foo/bar" }
  "https://github.com/foo/bar/"     → { host: "github.com",   path: "foo/bar" }
  "https://GitHub.com/foo/bar.git"  → { host: "github.com",   path: "foo/bar" }
  "file:///abs/path/to/repo"        → { host: "local",        path: "abs/path/to/repo" }
  "/abs/path/to/repo" (local ref)   → { host: "local",        path: "abs/path/to/repo" }

Rules:
  - strip scheme, user@, trailing slash, trailing `.git`
  - lowercase host
  - file:// and local paths normalize to host="local"; path is the absolute path with the leading `/` stripped
  - reject path components equal to `..`, empty, or starting with `.`; refuse to build a cache path
```

```
deriveCachePath(normalized) → "<host>/<path>.git"
```

Path-safety is enforced by an explicit validator — grove never relies on `path.join` alone to sanitize a remote-controlled URL.

**Local `RepoRef` with no `origin` remote:** `resolveRepo` returns `{ bareClonePath: ref.path, fetched: false, stale: false }` and skips the cache entirely. Preserves today's "cloned with no remote" case (e.g., `git init`-only repos).

**Local `RepoRef` with an `origin` remote:** resolve to `origin`'s URL, normalize, and use the cache like any URL ref.

### On-disk layout

Cache-root resolution order:

1. `$GROVE_REPO_CACHE` (absolute path).
2. `repoCache.path` in grove config file.
3. `$XDG_CACHE_HOME/grove/repo-cache/` (fall back to `~/.cache/grove/repo-cache/` when `XDG_CACHE_HOME` is unset).

Per-entry layout:

```
<cache-root>/
  .locks/
    github.com__windoliver__grove.git.lock   # per-entry lockfile; lives OUTSIDE the cache entry
  github.com/
    windoliver/
      grove.git/              # bare clone (GIT_DIR; no worktree)
        .grove-cache/         # grove metadata, sibling to git internals
          manifest.json       #   canonical url, aliases seen, timestamps
          .ok                 #   sentinel: present ⇒ clone completed cleanly
          last-fetch          #   mtime used for 60s TTL check
```

Lockfiles live under `<cache-root>/.locks/` so that a corrupt-entry recovery (`rm -rf <cacheDir>`) never removes the lockfile we are currently holding. The encoded lockfile name is the cache key with `/` replaced by `__`.

`manifest.json`:

```jsonc
{
  "canonicalUrl": "https://github.com/foo/bar",
  "aliases": ["git@github.com:foo/bar.git", "https://github.com/foo/bar.git"],
  "createdAt": "2026-04-21T...",
  "lastFetchedAt": "2026-04-21T...",
  "lastAccessedAt": "2026-04-21T..."
}
```

`.ok` is written by an atomic temp-file + rename after `git clone --bare` returns 0. Missing `.ok` on an otherwise populated `cacheDir` means a prior clone crashed; recovery nukes and re-clones under the held lock.

`aliases` is append-only — records every URL form grove has seen for this entry. Useful for debugging and as input to any future eviction heuristic.

### `resolveRepo` flow

```
1. If ref.kind === "local" and the path has no `origin` remote
     → return { bareClonePath: ref.path, fetched: false, stale: false }

2. Normalize URL
     If ref.kind === "local" with origin: read `origin` via `git -C <path> remote get-url origin`
     Compute cacheDir = <cacheRoot>/<host>/<path>.git

3. Acquire flock on <cacheRoot>/.locks/<encoded-key>.lock
     Create <cacheRoot>/.locks/ if needed; the lockfile lives OUTSIDE the cache entry
     so step 4a's rm -rf cannot unlink the lock we're holding

4. If <cacheDir>/.grove-cache/.ok is missing:
     a. If cacheDir is non-empty → rm -rf (corrupt from prior crash); log recovery
     b. git clone --bare <url> <cacheDir>              (subprocess, with timeoutMs)
     c. mkdir .grove-cache/; write manifest.json; write .ok (atomic rename)
     d. touch last-fetch
     e. fetched = true

5. Else (cache hit):
     a. Read manifest; append raw URL to aliases if new; update lastAccessedAt
     b. If opts.fresh OR now - mtime(last-fetch) > fetchTtlMs:
          try `git fetch --all --prune` in cacheDir
            success → touch last-fetch; fetched = true
            failure →
              if opts.fresh → release lock, throw (hard-fail)
              else         → log warn; stale = true; fetched = false

6. Release flock

7. Return { ref, bareClonePath: cacheDir, key, fetched, stale }
```

Per-step detail:

- **Locking (step 3).** `flock()` via a portable shim (`proper-lockfile` or equivalent) keeps the Windows door open even though Windows isn't officially supported. Lockfiles live at `<cacheRoot>/.locks/<encoded-key>.lock`, outside the cache entry — the corrupt-entry recovery path (`rm -rf <cacheDir>`) never touches them. The lock covers clone + fetch only. `git worktree add` runs in `workspace-provisioner` later, without this lock — git's internal ref-locking is sufficient and branch names are already session-scoped (`grove/{sessionId}/{role}`) so two worktree adds cannot collide.
- **Corruption recovery (step 4a).** The absence of `.ok` is the sole corruption signal. Grove does not run `git fsck` — too expensive on every session start. Users who hit real object corruption can `grove repo prune <key>` and retry.
- **Fetch TTL (step 5b).** mtime-based; no extra state. Tuned to 60s as the default; overridable per call (tests use 0 or very large values).
- **Offline / flaky fetch (step 5b).** Stale cache wins over hard-fail unless `--fresh` was explicitly requested.
- **Auth.** Inherit git's existing config — `credential.helper`, SSH agent, `.netrc`. The subprocess runs with `GIT_TERMINAL_PROMPT=0` so a missing credential fails fast instead of hanging a TUI on an invisible prompt.
- **Timeout.** Clone and fetch run under an `AbortController` with `timeoutMs` (default 5 min). On timeout: kill the subprocess, release the lock, throw. A half-finished clone is safe — the missing `.ok` triggers auto-recovery on the next call.

### Integration with existing provisioner + callers

**`workspace-provisioner.ts` signature.**

```ts
// before
interface WorkspaceProvisionOptions {
  readonly role: string;
  readonly sessionId: string;
  readonly baseDir: string;
  readonly repoRoot: string;               // removed
  readonly baseBranch?: string;
  readonly mcpConfig?: Record<string, unknown>;
}

// after
interface WorkspaceProvisionOptions {
  readonly role: string;
  readonly sessionId: string;
  readonly baseDir: string;
  readonly bareClonePath: string;          // from resolveRepo(...).bareClonePath
  readonly baseBranch?: string;
  readonly mcpConfig?: Record<string, unknown>;
}
```

Inside `provisionWorkspace` the only substantive change is `cwd: repoRoot` → `cwd: bareClonePath`. `git worktree add <path> -b <branch> <base>` works identically against a bare clone; the bare-vs-checkout distinction is invisible at this call site. `cleanupSessionWorkspaces` changes `repoRoot` → `bareClonePath` for the same reason.

**Session-level config.**

```ts
// before
interface SessionOrchestratorConfig {
  readonly projectRoot: string;
  ...
}

// after
interface SessionOrchestratorConfig {
  readonly repos: readonly RepoRef[];                // length ≥ 1 (today: exactly 1)
  readonly repoCache?: Partial<ResolveRepoOptions>;
  ...
}
```

`projectRoot` is removed from both `SessionOrchestratorConfig` and the `SpawnManager` equivalent in the same PR. Grove has one external CLI entry point plus a handful of test harnesses; no compat shim is needed.

At session start:

```ts
const resolved = await Promise.all(
  config.repos.map(ref => resolveRepo(ref, config.repoCache)),
);
// today: resolved[0] is the session's only repo
```

`AgentRole` gains an optional `repoIndex?: number` (defaults to 0). Today it is unused; the multi-repo sub-spec will wire it. Shipping the field now keeps `repos: RepoRef[]` from being a breaking change later.

**CLI surface.**

- `grove up`, `grove session start`, etc. accept `--repo <url-or-path>`. The flag parses as repeatable (forward-compat with multi-repo sessions), but today grove rejects >1 `--repo` values with an explicit error pointing at the deferred multi-repo sub-spec. Silent truncation is not acceptable.
- When `--repo` is omitted, grove resolves `process.cwd()` to a `local` `RepoRef`. If cwd is not inside a git repo, grove errors with an actionable message (`run grove from inside a git repo, or pass --repo <url>`).
- New sibling commands under `src/cli/commands/repo.ts`:
  - `grove repo list` — walk cache root, print each entry's key + manifest summary.
  - `grove repo prune [<key>|--all]` — remove cache entries. Before removing: check `git worktree list` in the bare clone; if any worktree still references it, refuse with an actionable error.
  - `grove repo fetch <key>` (optional, nice-to-have) — explicit fetch, equivalent to calling `resolveRepo(ref, { fresh: true })`.

### Testing strategy

- `repo-ref.test.ts` — table-driven normalization (SSH, HTTPS, case, trailing slash/`.git`, `file://`, local absolute path); path-safety rejects traversal (`..`, empty segment, leading dot).
- `repo-cache.test.ts` — integration tests against real `git` using `file://` URLs that point at fixture bare repos created in `beforeAll`. Covers:
  - fresh clone creates `.ok`, manifest, and last-fetch;
  - cache hit within TTL skips fetch;
  - TTL expiry triggers fetch; failure produces `stale: true`;
  - `fresh: true` forces fetch; failure throws;
  - concurrent `resolveRepo` calls on the same key serialize via the lock (one clones, the rest see cache hit);
  - missing `.ok` triggers auto-reclone;
  - timeout kills subprocess and leaves the entry recoverable on next call.
- `workspace-provisioner.test.ts` — existing tests updated to pass `bareClonePath` (pointing at a fixture bare clone) instead of `repoRoot`.
- End-to-end: one test runs a session against a `file://` bare-clone fixture and verifies agent worktrees are created and can commit.

No test ever contacts a real remote. CI runs offline.

### Observability

- Every `resolveRepo` call logs (at info) a line with `{ key, hit, fetched, stale, durationMs }`.
- `grove repo list` reads the same manifests; any debugging session starts there.
- Structured errors from clone/fetch include the cache key and the full git stderr.

## Risks

- **Windows.** `flock()` is POSIX; the codebase uses a portable lockfile shim (`proper-lockfile` or equivalent) so Windows stays possible even though it's unsupported today.
- **`file://` URL normalization.** Edge case — `file:///abs/path/to/repo` vs `/abs/path/to/repo`. Rule: both normalize to `{ host: "local", path: <abs path, leading "/" stripped> }`. Makes `file://` fixtures deterministic in tests.
- **Network in tests.** All tests use `file://` fixtures created in `beforeAll`. No real remotes.
- **Clone blocks session start.** First-time clone of a big repo can take minutes. The UX surfaces a "cloning repo…" status (same hook already used for provisioning). Hard timeout (5 min default) prevents an indefinite hang.
- **Disk pressure.** Unbounded cache + big repos = surprise disk bill. Mitigated by `grove repo list` and `grove repo prune`; called out in README.
- **Bare-clone worktree edge cases.** `git worktree add` from a bare clone works, but HEAD of the bare repo is a detached symbolic ref. Confirmed-safe call shape: `git worktree add <path> -b <new-branch> <base>` where `<base>` is `HEAD`, an explicit branch, or an SHA — matches what `workspace-provisioner` already uses.
- **Credential prompts hanging the TUI.** `GIT_TERMINAL_PROMPT=0` on the subprocess env prevents this class of hang.

## Rollout

Single PR chain, no feature flag:

1. Land `repo-ref.ts` + `repo-cache.ts` + their tests. No callers yet — pure additive.
2. Change `workspace-provisioner.ts` signature (`repoRoot` → `bareClonePath`); update `SpawnManager`, `SessionOrchestrator`, tests, CLI in one PR.
3. Add `grove repo list` / `grove repo prune` CLI.
4. Update README, QUICKSTART, GROVE.md for the `--repo` flag and the new cache location.

Feature-flagging this does not pay off: the cache is required for external repos, and the existing local-repo flow goes through the same `resolveRepo` call (which short-circuits for a local path with no `origin`, and clones-to-cache otherwise). One code path, tested once.

## Open questions

None at design time. Implementation may surface tuning (default TTL, default timeout, lockfile library choice) that the plan will pin down.
