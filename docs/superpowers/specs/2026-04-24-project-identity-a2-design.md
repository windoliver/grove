# A2: Project Identity — UUID Persistence + User-Level Registry — Design

- **Issue**: [#288](https://github.com/windoliver/grove/issues/288)
- **Epic**: [#282](https://github.com/windoliver/grove/issues/282) — Foundation: Entity Model + Watch Protocol
- **Date**: 2026-04-24

## Goal

Give every Grove-initialized repository clone a stable UUIDv4 identity that
lives inside `.grove/`, and correlate clones of the same remote through an
opt-in user-level registry at `~/.grove/projects.yaml`. The UUID becomes the
canonical project-scoping key for later work (namespace enforcement, watch
channels, entity ownership).

## Non-goals

- Server-side namespace isolation (that is #290).
- Migration of existing `.grove/` directories created before this change (#291).
- Post-hoc unification of two clones that already have distinct UUIDs. Only
  init-time unification is in scope; post-hoc merging is a future `grove
  project unify` subcommand filed separately if needed.
- Multi-origin or renamed-repo history in the registry. Single origin per
  entry; registry schema is `version: 1` and can be extended later.

## Derivation flow (authoritative)

On every `grove init`, in order:

1. If `.grove/project-id` exists and contains a valid UUIDv4 → use it. No prompt.
   No registry write. (Re-running `grove init` is idempotent.)
2. Else, detect the git `origin` remote for the working directory and normalize it.
   - No remote, or unparseable URL → generate a new UUIDv4, write
     `.grove/project-id`, do **not** touch the registry. Return.
3. Else, load `~/.grove/projects.yaml` and look up the normalized origin.
   - **Miss** → generate a new UUIDv4, write `.grove/project-id`, upsert a
     registry entry keyed by origin, save registry. Return.
   - **Hit** → decide whether to adopt (unify with existing project id) or to
     create a new project anyway (two logical projects sharing an origin):
     - `--unify` flag set → adopt.
     - `--no-unify` flag set → new.
     - TTY + stdin is a TTY → prompt:
       `Matching project '<name>' already registered (id <uuid>). Unify? [Y/n]`
       Enter / `y` / `Y` → adopt. `n` / `N` → new.
     - Non-TTY, no flag → **new** (default matches spec: "multiple clones = multiple
       logical projects by default").
   - If adopt: write `.grove/project-id` with the registry's id. No registry
     change (origin already points at that id).
   - If new: generate a new UUIDv4, write `.grove/project-id`. **Do not modify
     the registry** — the origin key already belongs to the first clone; leave
     that entry intact.

## Module layout

```
src/core/
  project-id.ts           pure: read / write / validate .grove/project-id
  project-registry.ts     pure: load / save ~/.grove/projects.yaml, lookup by origin

src/cli/utils/
  origin-url.ts           git origin detection + normalization
  ensure-project-id.ts    orchestrator: derivation flow + TTY prompt

src/cli/commands/init.ts  calls ensureProjectId() after .grove/ created
```

Pure modules (`src/core/`) have no side effects beyond fs I/O at explicit
paths they are given. The orchestrator owns the prompt, process.stdout,
process.stdin, `process.stdout.isTTY`, and default registry path resolution —
all injectable via `EnsureOpts` for tests.

## Public API

### `src/core/project-id.ts`

```ts
export const PROJECT_ID_FILE = "project-id";

export function generateProjectId(): string;
// crypto.randomUUID() — Bun + Node 19+ support this natively.

export function isValidProjectId(s: string): boolean;
// UUIDv4 regex: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function readProjectId(groveDir: string): string | null;
// returns UUIDv4 string, or null if file missing / empty.
// throws Error(`Invalid project id in <path>. Fix the file or delete it to regenerate.`)
// if file exists non-empty but contents are not a valid UUIDv4.

export function writeProjectId(groveDir: string, id: string): void;
// validates id; writes "<id>\n" to "<groveDir>/project-id" atomically
// (tmp file in same dir + rename). Mode 0644.
```

### `src/core/project-registry.ts`

```ts
export interface RegistryEntry {
  readonly id: string;         // UUIDv4
  readonly name: string;       // tail of origin path, e.g. "foo/bar"
  readonly createdAt: string;  // ISO 8601 UTC
}

export interface Registry {
  readonly version: 1;
  readonly projects: Readonly<Record<string, RegistryEntry>>;  // key = normalized origin
}

export function defaultRegistryPath(): string;
// $HOME/.grove/projects.yaml; throws if HOME unresolvable.

export function loadRegistry(path: string): Registry;
// missing file → { version: 1, projects: {} }
// malformed YAML → throws
// unknown version → throws
// invalid UUIDv4 in any entry → throws

export function saveRegistry(path: string, reg: Registry): void;
// mkdirp parent; atomic write via tmp + rename; 0644.
// yaml.stringify with 2-space indent.

export function lookupByOrigin(reg: Registry, origin: string): RegistryEntry | null;

export function upsertEntry(
  reg: Registry,
  origin: string,
  entry: RegistryEntry,
): Registry;
// returns new Registry; does not mutate input.
```

### `src/cli/utils/origin-url.ts`

```ts
export function detectOriginUrl(cwd: string): string | null;
// spawns `git -C <cwd> remote get-url origin`. Returns trimmed stdout on exit 0.
// Returns null on: non-zero exit, missing binary, not a git repo, no origin remote.
// Never throws.

export function normalizeOriginUrl(raw: string): string | null;
// Q1-A rules; see "Normalization rules" below.
```

### `src/cli/utils/ensure-project-id.ts`

```ts
export interface EnsureOpts {
  readonly groveDir: string;
  readonly cwd: string;
  readonly unify?: boolean;                       // --unify / --no-unify; undefined = prompt or default
  readonly isTTY?: boolean;                       // default: process.stdout.isTTY && process.stdin.isTTY
  readonly registryPath?: string;                 // default: defaultRegistryPath()
  readonly now?: () => Date;                      // default: () => new Date()
  readonly stdin?: NodeJS.ReadableStream;         // default: process.stdin
  readonly stdout?: NodeJS.WritableStream;        // default: process.stdout
}

export type EnsureSource = "local" | "registry" | "generated";

export interface EnsureResult {
  readonly id: string;
  readonly source: EnsureSource;
  readonly origin: string | null;  // normalized origin, or null
  readonly registered: boolean;    // true if a registry entry now exists for origin and points at id
}

export async function ensureProjectId(opts: EnsureOpts): Promise<EnsureResult>;
```

## File formats

### `.grove/project-id`

```
550e8400-e29b-41d4-a716-446655440000
```

- UTF-8, single UUIDv4 line, trailing `\n` on write; trailing newline optional on read.
- Mode `0644`. Written atomically (tmp file in same dir + `fs.renameSync`).
- Empty file treated as missing (previous init was interrupted; regenerate).
- Non-empty, not a UUIDv4 → throw. Never silently overwrite.

### `~/.grove/projects.yaml`

```yaml
version: 1
projects:
  github.com/foo/bar:
    id: 550e8400-e29b-41d4-a716-446655440000
    name: foo/bar
    createdAt: 2026-04-24T15:38:00.000Z
  gitlab.com/acme/service:
    id: 3f2504e0-4f89-41d3-9a0c-0305e82c3301
    name: acme/service
    createdAt: 2026-04-23T10:12:45.000Z
```

- `version: 1` required. Any other value → throw (forward-compat stub).
- Missing file → treated as empty registry; parent dir `mkdir -p`'d on first write.
- Malformed YAML → throw; never overwrite silently.
- Atomic writes (tmp + rename), 0644, `yaml.stringify` with default 2-space indent.

### Origin URL normalization rules

| Input | Normalized |
| --- | --- |
| `https://github.com/Foo/Bar.git` | `github.com/Foo/Bar` |
| `https://github.com/Foo/Bar` | `github.com/Foo/Bar` |
| `http://github.com/Foo/Bar` | `github.com/Foo/Bar` |
| `git@github.com:Foo/Bar.git` | `github.com/Foo/Bar` |
| `ssh://git@github.com/Foo/Bar.git` | `github.com/Foo/Bar` |
| `ssh://git@github.com:22/Foo/Bar.git` | `github.com/Foo/Bar` |
| `git://github.com/Foo/Bar` | `github.com/Foo/Bar` |
| `git+ssh://git@github.com/Foo/Bar.git` | `github.com/Foo/Bar` |

Algorithm:

1. Strip known scheme prefixes: `https://`, `http://`, `ssh://`, `git://`, `git+ssh://`. Case-insensitive.
2. Strip `user@` prefix at start if present (everything up to and including the first `@` that appears before the first `/` or `:`).
3. If the remainder is SCP-style (`host:path` where the portion before `:` contains no `/`), replace the first `:` with `/`.
4. Strip `:<port>` immediately after host (digits only) if present and followed by `/`.
5. Strip trailing `.git`.
6. Strip trailing `/`.
7. Lowercase the host (characters up to the first `/`). Preserve path case (GitLab paths are case-sensitive).
8. If the result has no `/`, return `null`.
9. Otherwise return the normalized string.

## CLI surface

`grove init` gains two mutually-exclusive flags:

- `--unify` — on registry-hit, adopt the existing project id without prompting.
- `--no-unify` — on registry-hit, create a new project id without prompting.
- Both supplied → exit non-zero with `--unify and --no-unify are mutually exclusive.`

Progress-line output, added to existing init log sequence:

| Source | Line |
| --- | --- |
| `local` | `project id <uuid> (existing)` |
| `registry` | `project id <uuid> (unified with <name>)` |
| `generated`, origin non-null, registered | `project id <uuid> (new, registered as <name>)` |
| `generated`, origin non-null, not registered | `project id <uuid> (new, origin already owned — not registered)` |
| `generated`, origin null | `project id <uuid> (new, no origin — not registered)` |

## Errors & edge cases

| Situation | Behavior |
| --- | --- |
| `.grove/project-id` exists, valid | Use. Idempotent. |
| `.grove/project-id` exists, malformed | Throw with path + remediation hint. |
| `.grove/project-id` exists, empty | Treat as missing; regenerate. |
| No git repo / no `origin` remote | Skip registry; generate + write local only. |
| Origin URL unparseable | stderr warn `Unrecognized origin URL format: <raw> — registry skipped.` Generate + write local. |
| `~/.grove/projects.yaml` missing | Empty registry; created on first write. |
| `~/.grove/projects.yaml` malformed | Throw with path + "fix or move aside" hint. |
| `~/.grove/projects.yaml` unknown version | Throw (forward-compat stub). |
| Registry hit + `--unify` | Adopt existing id. |
| Registry hit + `--no-unify` | New id; registry untouched. |
| Registry hit + TTY + no flag | Prompt. |
| Registry hit + non-TTY + no flag | New id (default). Registry untouched. |
| `--unify` + `--no-unify` both set | Exit non-zero, friendly message. |
| HOME unresolvable | Throw `Cannot resolve user home directory for ~/.grove registry.` |
| Concurrent `grove init` in same clone | Last writer wins. No lock (not a supported scenario). |
| Concurrent `grove init` in two clones of same origin | Registry last-writer-wins. Acceptable — both clones hold valid local ids, one registers. |
| `GROVE_DIR` env override | Already handled by `resolveGroveDir`; `.grove/project-id` lives inside whatever that resolves to. No change. |

## Testing plan

### Unit — `src/core/project-id.test.ts`

- `generateProjectId()` returns a string matching the UUIDv4 regex.
- `isValidProjectId` rejects: empty, `""`, UUIDv1 fixture, UUIDv7 fixture, `"not-a-uuid"`, valid UUIDv4 with surrounding whitespace (strict).
- `readProjectId` on missing file → `null`.
- `readProjectId` on empty file → `null`.
- `readProjectId` on `"<uuid>"` and `"<uuid>\n"` → id.
- `readProjectId` on `"garbage"` → throws.
- `writeProjectId` rejects invalid id.
- `writeProjectId` followed by `readProjectId` round-trips.
- Second `writeProjectId` with same id is stable (file contents byte-equal).

### Unit — `src/core/project-registry.test.ts`

- `loadRegistry` on missing path → `{ version: 1, projects: {} }`.
- `loadRegistry` on malformed YAML → throws.
- `loadRegistry` on `version: 2` → throws.
- `loadRegistry` on entry with non-UUIDv4 id → throws.
- `saveRegistry` then `loadRegistry` round-trips an entry with all fields.
- `saveRegistry` creates parent directory if missing.
- `lookupByOrigin` returns entry on match, null on miss.
- `upsertEntry` inserts new and overwrites existing without mutating input.

### Unit — `src/cli/utils/origin-url.test.ts`

- Table-driven test: every row of the normalization table → expected output.
- `normalizeOriginUrl("")` → `null`.
- `normalizeOriginUrl("file:///tmp/repo")` → `null` (no host/path in expected shape — or explicitly rejected).
- `normalizeOriginUrl("just-a-string")` → `null`.
- Case preservation: `github.com/ACME/Repo` stays mixed-case in path.
- Host lowercased even when raw is uppercase: `https://GitHub.com/foo/bar` → `github.com/foo/bar`.
- `detectOriginUrl` in a tmp git repo with `git remote add origin <url>` → returns raw.
- `detectOriginUrl` in a tmp git repo with no origin → `null`.
- `detectOriginUrl` in a non-git tmp dir → `null`.

### Integration — `src/cli/utils/ensure-project-id.test.ts`

Each test seeds a fresh tmp `groveDir`, a fresh tmp `registryPath`, and a
synthetic origin (either injected by stubbing `detectOriginUrl` with a test
harness, or by creating a throwaway git repo and setting origin).

- Existing local file → returns `source: "local"`, registry untouched, no prompt.
- No origin, no local → `source: "generated"`, `origin: null`, registry untouched.
- Origin, registry miss → `source: "generated"`, registry now contains entry for origin.
- Origin, registry hit, `unify: true` → `source: "registry"`, local id equals registry id.
- Origin, registry hit, `unify: false` → `source: "generated"`, local id ≠ registry id, registry unchanged.
- Origin, registry hit, `isTTY: true`, stdin feeds `"y\n"` → adopts.
- Origin, registry hit, `isTTY: true`, stdin feeds `"\n"` (default Y) → adopts.
- Origin, registry hit, `isTTY: true`, stdin feeds `"n\n"` → new.
- Origin, registry hit, `isTTY: false`, no flag → new (default).
- Idempotent: call twice; second call returns `source: "local"` with same id.
- Malformed local file → throws.
- Malformed registry file → throws.

### E2E — additions to `src/cli/commands/init.test.ts`

Fulfilling the issue's four acceptance criteria directly:

1. `grove init` on a fresh repo creates `.grove/project-id` whose contents
   match the UUIDv4 regex.
2. Two independent clones of the same synthetic origin (non-TTY) → two
   distinct UUIDs.
3. Second clone with `--unify` adopts the first's id; registry contains
   exactly one entry for the origin pointing at that id.
4. Re-running `grove init` in a clone leaves `.grove/project-id` unchanged.

### Manual smoke (documented, not automated)

One-time: run `grove init` in a TTY against a repo that already has a
registry entry, verify prompt appears and responds to `y` / `n` / Enter.

## Implementation order (TDD)

1. `src/core/project-id.ts` + test — red, green, refactor per function.
2. `src/core/project-registry.ts` + test — same.
3. `src/cli/utils/origin-url.ts` + test — same. `detectOriginUrl` is tested
   last and uses a real tmp git repo (no mocking of `git`).
4. `src/cli/utils/ensure-project-id.ts` + integration test — builds on pure
   modules. Prompt covered by feeding a stub stdin stream.
5. Wire `ensureProjectId` into `src/cli/commands/init.ts` (after `.grove/` is
   created, before `grove.json` is written). Add `--unify` / `--no-unify`
   flags and log line. Extend `init.test.ts` with the four acceptance tests.

Each step is its own commit. Step 5's commit closes #288.

## Out-of-scope follow-ups

- `grove project unify <uuid>` subcommand for post-hoc merging.
- `grove project list` / inspect subcommand reading the registry.
- Server-side enforcement that writes to a project use the local project-id
  (covered by #290).
- Migration of pre-existing `.grove/` dirs (covered by #291).
