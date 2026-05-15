# Grove Diagnostics Bundle - Design

- **Issue**: [#277](https://github.com/windoliver/grove/issues/277)
- **Date**: 2026-05-01
- **Status**: Approved
- **Related**: [#215](https://github.com/windoliver/grove/issues/215), [#217](https://github.com/windoliver/grove/issues/217), [#282](https://github.com/windoliver/grove/issues/282), [#297](https://github.com/windoliver/grove/issues/297), [#375](https://github.com/windoliver/grove/issues/375), [#376](https://github.com/windoliver/grove/issues/376), [#378](https://github.com/windoliver/grove/issues/378), [#379](https://github.com/windoliver/grove/issues/379)

## Goal

Add `grove diagnostics`, a local CLI command that creates a single ZIP archive
for bug reports. The archive should package enough current Grove state for
support and developers to diagnose a user report without asking for a sequence
of manual `cat`, `sqlite3`, and shell commands.

The first version exports all currently persisted local data and includes
explicit availability manifests for operator primitives that are still being
specified or implemented: WorkBlock/session timeline, RunHealth, autonomy
profiles, permission decisions, AgentTask state, watch lag/compaction/full
resync details, degraded stop-condition reasons, and bounded queue/backpressure
state.

## Non-goals

- Uploading the bundle. The operator chooses how to share the generated ZIP.
- Live health checks. `grove doctor` owns the live diagnostic story; this
  command creates a point-in-time bundle.
- Blocking on future operator models. The bundle records unavailable or partial
  primitive status now and can add concrete exports when those models land.
- Redacting SQLite database bytes. `grove.db` is copied only when requested by
  default behavior; `--exclude-db` is the privacy and size escape hatch.
- Starting, stopping, or contacting grove-server, Nexus, ACP providers, or the
  TUI. Diagnostics must work even when services are down.

## Command Shape

`grove diagnostics` is a standalone CLI command registered in
`src/cli/main.ts`. It follows the existing lazy import pattern and resolves the
target grove through the global `--grove` behavior.

Flags:

| Flag | Default | Behavior |
| --- | --- | --- |
| `--exclude-db` | false | Skip raw `db/grove.db`; still write JSON summaries |
| `--scrub=standard|aggressive|off` | `standard` | Select text redaction strength |
| `--slot <id>` | unset | Limit slot-scoped logs and summaries when data carries slot/session/agent identifiers |
| `--out <path>` | `./grove-diagnostics-<timestamp>.zip` | Destination ZIP path |

The command prints the absolute output path and a compact summary of included,
skipped, and failed sections. Bundle creation fails only when the target grove
cannot be resolved, the output path cannot be written, the raw database copy is
requested but cannot be read, or ZIP assembly fails.

## Architecture

```
grove diagnostics
  |
  |-- parse flags
  |-- resolve .grove directory
  |-- open local runtime/stores
  |-- collect bundle entries
  |     |-- metadata/config
  |     |-- logs and manifests
  |     |-- SQLite JSON exports
  |     |-- optional raw grove.db copy
  |     |-- operator primitive availability
  |     `-- system command snapshots
  |-- redact text entries unless --scrub=off
  `-- write ZIP archive
```

The implementation should be split into small modules:

- `src/cli/commands/diagnostics.ts`: argument parsing, command orchestration,
  output summary, and CLI help text.
- `src/cli/commands/diagnostics.test.ts`: command-level tests with temp
  groves and ZIP inspection.
- `src/diagnostics/bundle.ts`: bundle entry collection and manifest assembly.
- `src/diagnostics/redaction.ts`: deterministic scrubber for text and JSON
  entries.
- `src/diagnostics/sqlite-export.ts`: table discovery and JSON/JSONL exports
  using Bun SQLite.
- `src/diagnostics/system.ts`: best-effort system probes with per-file fallback
  text.
- `src/shared/zip.ts`: small Bun-compatible ZIP writer for stored entries
  using no external `zip` binary and no new dependency.

The ZIP writer should use method 0 (stored, no compression). That keeps the
implementation small, deterministic, and dependency-free. If a single entry or
archive would exceed classic ZIP limits, the command should fail with a clear
message recommending `--exclude-db`; ZIP64 support is out of scope for the
first version.

## Bundle Layout

The archive root is flat and deterministic:

```
meta.json
README.md
config/
  GROVE.md
  grove-settings.json
  env.redacted.json
logs/
  manifest.json
  agent-logs/...
db/
  grove.db
  contributions-recent.jsonl
  sessions.json
  claims.json
  handoffs.json
  outcomes.json
  bounties.json
  workspaces.json
  idempotency.json
operator-primitives/
  availability.json
system/
  process-tree.txt
  disk-usage.txt
  open-fds.txt
```

Files that are not present in a given grove are omitted from their content
location and recorded in the relevant manifest. Optional sections should not
produce empty placeholder content files.

### `meta.json`

Contains:

- bundle schema version, initially `1`
- generated timestamp in UTC
- Grove package version from `package.json`
- Bun version
- platform, release, arch, CPU count, total memory, free memory
- command flags
- resolved `.grove` path with the current user's home directory replaced by
  `~`
- inclusion summary and per-section warnings

### `README.md`

Explains what each top-level directory contains, how redaction was applied, and
which files may contain sensitive data. The README is generated so it can record
the actual scrub mode and whether `grove.db` was included.

### `config/`

- `GROVE.md`: copied from the project root when present.
- `grove-settings.json`: JSON export of `project_settings` rows.
- `env.redacted.json`: allowlisted diagnostic environment keys plus all
  `GROVE_*` keys, after redaction.

The environment export should not dump every variable by default. It should
include keys useful for Grove debugging and common runtime context, including
`GROVE_*`, `BUN_*`, `PATH`, `SHELL`, `TERM`, `HOME`, `USER`, `TMPDIR`, and CI
markers. Redaction still applies.

### `logs/`

The command recursively includes `.grove/agent-logs/**` and known log files if
they exist, including `grove-runtime.log`, `ipc.log`, and server/TUI runtime
logs when future code creates those names. `logs/manifest.json` records every
matched, skipped, missing, unreadable, and slot-filtered path.

`--slot <id>` applies to logs by matching path segments and file names that
contain the slot ID, session ID, or role/session convention already stored in
the path. If no paths match, the manifest records the miss and the command still
continues.

### `db/`

`grove.db` is copied byte-for-byte unless `--exclude-db` is set. All other DB
files are normalized JSON or JSONL exports and are included whether or not the
raw DB is copied.

Current exports:

- `contributions-recent.jsonl`: newest 500 contribution manifests, newest first.
- `sessions.json`: rows from `sessions`, including config/topology JSON fields
  when present.
- `claims.json`: rows from `claims`.
- `handoffs.json`: rows from `handoffs` when the table exists.
- `outcomes.json`: rows from outcome tables when they exist.
- `bounties.json`: rows from bounty tables when they exist.
- `work-blocks.json`: rows from `work_blocks` when they exist.
- `timeline-events.json`: rows from `timeline_events` when they exist.
- `timeline-cursors.json`: rows from `timeline_cursors` when they exist.
- `workspaces.json`: rows from `workspaces`.
- `idempotency.json`: `cache_key`, `status`, and `stored_at`; fingerprints and
  cached results are redacted as text before writing.
- `table-manifest.json`: table presence, row counts, and export warnings.

Exports must use table discovery instead of assuming all newer tables exist.
Missing tables are represented in `table-manifest.json`, not as command
failures.

### `operator-primitives/availability.json`

This file reports the issue-comment additions without pretending the models
already exist. Each item contains `name`, `status`, `sources`, and `notes`.

Initial statuses:

- `session_timeline`: `partial`, sourced from `timeline_events`,
  `timeline_cursors`, `sessions`, and `agent-logs`.
- `work_blocks`: `partial`, sourced from `work_blocks`, `timeline_events`, and
  `timeline_cursors`.
- `run_health`: `partial`, sourced from session status, stop reasons, claims,
  handoffs, and watch/backpressure metadata when available.
- `autonomy_profile`: `unavailable`, pending #378.
- `permission_decisions`: `partial`, sourced from ACP trace lines and typed
  permission request log messages when present.
- `agent_tasks`: `unavailable`, pending #297 and #379.
- `watch_compaction`: `partial`, sourced from persisted config and any local
  watch metrics snapshots if future code writes them.
- `degraded_stop_conditions`: `partial`, sourced from session `stop_reason`,
  contract stop conditions, and contribution warnings.
- `bounded_queue_backpressure`: `partial`, sourced from log lines and any
  persisted channel stats if future code writes them.

When future tables or provider APIs land, diagnostics can change individual
items from `unavailable` or `partial` to `available` and add concrete exports
without changing the command contract.

### `system/`

System probes are best-effort text snapshots:

- `process-tree.txt`: process listing filtered for Grove, Bun, ACP provider,
  and Nexus-related processes where the platform supports it.
- `disk-usage.txt`: `.grove` and project directory usage.
- `open-fds.txt`: open file descriptors for running Grove-related processes
  where `lsof` or `/proc` is available.

Unsupported commands write a short explanation into the target file and add a
warning to `meta.json`.

## Redaction

Redaction runs after text/JSON collection and before ZIP writing. It applies to
all text-like files: `.json`, `.jsonl`, `.md`, `.txt`, `.log`, and extensionless
text entries. It does not modify `db/grove.db`.

Standard scrub order:

1. API-key-like tokens by common key patterns.
2. Absolute current-home paths to `~`.
3. Email addresses to `<redacted>`.
4. URLs whose query string includes `token=`, `key=`, `api_key=`, or
   `access_token=` to the same URL without sensitive query values.

Aggressive mode additionally redacts:

- long bearer-like tokens
- known secret environment variable values
- non-home absolute local paths
- HTTP authorization header values
- SSH private key blocks

`--scrub=off` applies no text redaction and records that fact in `meta.json`
and `README.md`.

## Error Handling

Diagnostics should be useful even from a partially broken grove. The command
continues on optional read failures and records them in manifests.

Fatal errors:

- no grove can be resolved
- output path cannot be created or overwritten
- raw `grove.db` is requested and cannot be read
- ZIP assembly fails

Non-fatal errors:

- optional logs missing or unreadable
- optional future primitive exports unavailable
- system probe commands missing or failing
- optional SQLite tables absent
- malformed optional JSON in rows

## Testing

Use `bun test` with focused tests around the new command and helpers.

Required tests:

- `parseDiagnosticsArgs` accepts defaults and all flags.
- invalid `--scrub` values fail with a usage error.
- default output name uses `grove-diagnostics-<timestamp>.zip`.
- a temp `.grove` with a SQLite DB produces a ZIP containing `meta.json`,
  `README.md`, config files, DB summaries, logs manifest, and operator
  availability.
- `--exclude-db` omits only `db/grove.db`; JSON summaries remain.
- `contributions-recent.jsonl` is newest-first and capped at 500.
- standard redaction handles API keys, home paths, emails, and sensitive URL
  query params in the documented order.
- aggressive redaction additionally redacts bearer-like tokens and non-home
  absolute paths.
- `--scrub=off` preserves text.
- missing optional tables and logs are recorded in manifests without throwing.
- future primitive availability reports unavailable or partial statuses when no
  final schema exists.
- CLI registration includes `diagnostics` in global help and dispatches to the
  command handler.
- ZIP writer round-trips multiple stored entries with correct names and bytes.

Full verification before completion should run:

```bash
bun test src/cli/commands/diagnostics.test.ts src/diagnostics/redaction.test.ts src/shared/zip.test.ts
bun run typecheck
bun run check
```

## Acceptance Criteria

- `grove diagnostics` creates a valid ZIP from an initialized local grove.
- The ZIP contains current persisted Grove state, current logs, current config,
  best-effort system data, and a generated README.
- The raw SQLite database can be excluded while preserving JSON summaries.
- Redaction defaults to `standard`, can be made stricter, and can be explicitly
  disabled.
- Future operator primitives are represented honestly through availability
  metadata.
- Missing optional data is visible in manifests and does not make the command
  fail.
- The implementation is Bun-only and does not require Node.js, Jest, Vitest,
  ESLint, Prettier, or an external `zip` command.
