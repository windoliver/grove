# Eval harness completion — `grove eval` + `hooks.eval` (#211)

**Date:** 2026-05-30
**Issue:** [#211](https://github.com/windoliver/grove/issues/211)
**Status:** Design approved (user delegated: "whatever you recommend")

## Context

Issue #211 asks for a first-class eval harness: `modify → eval → score → leaderboard`.
Three commits already shipped part of it:

- `src/core/operations/eval.ts` — `evalOperation`
- `src/mcp/tools/eval.ts` — `grove_eval` MCP tool (opt-in, disabled by default)
- export from `src/core/operations/index.ts`

The shipped implementation **diverged** from the issue's prose spec:

| Aspect | Issue prose | Shipped `evalOperation` |
|---|---|---|
| Score protocol | JSON stdout `{"scores":{...}}` | `GROVE_SCORE name=value` lines (stdout/stderr) |
| Env passed to script | `GROVE_EVAL_DIR` + `GROVE_EVAL_CID` | `GROVE_TARGET_CID` only |
| Artifact checkout | yes (workspace dir) | no |
| Resolve cmd from `contract.hooks.eval` | yes | no (command required as input) |
| `--submit` reproduction | yes | no |

The two score protocols are mutually incompatible.

## Decision

**Extend the shipped `GROVE_SCORE`-line design. Do not rewrite the merged core op or MCP tool.**

Rationale: the shipped protocol is merged, tested, and on the public MCP surface. The
`GROVE_SCORE`-line contract is simpler than JSON-stdout (line-streamed, tolerant of progress
output) and already works. Rewriting it discards working code and breaks the `grove_eval`
MCP contract for no functional gain. We add the genuinely-useful, non-conflicting pieces the
issue wants on top of the shipped foundation.

## Components

### 1. Contract — `src/core/hooks.ts`

Add `eval` to the hooks schema:

```ts
export interface HooksConfig {
  readonly after_checkout?: HookEntry | undefined;
  readonly before_contribute?: HookEntry | undefined;
  readonly after_contribute?: HookEntry | undefined;
  readonly eval?: HookEntry | undefined;        // NEW
}
```

Add `eval: HookEntrySchema.optional()` to `HooksConfigSchema` (still `.strict()`). Update the
module doc comment to list the `eval` hook. `HookEntry` already supports the `{cmd, timeout}`
object form, so per-eval timeout is free.

### 2. Core op — `src/core/operations/eval.ts`

When `input.evalCommand` is absent, resolve the command from `deps.contract?.hooks?.eval`:

- string form → use directly
- `{cmd, timeout}` form → use `cmd`; if `input.timeoutMs` is also absent, use the hook's
  `timeout` (ms) as the resolved timeout
- neither input nor contract → existing `VALIDATION_ERROR`

`evalOperation` currently ignores `deps` (`_deps`). Change to read `deps.contract`. The
`OperationDeps` type already carries an optional `contract`. No behavior change when a command
is passed explicitly — fully backward compatible. The MCP tool keeps passing an explicit
`evalCommand`, so its behavior is unchanged; CLI gains contract resolution.

Add **`src/core/operations/eval.test.ts`** (currently zero coverage): score parsing
(stdout + stderr, int/float/scientific/negative), non-score line tolerance, partial-final-line
flush, timeout → `timedOut: true` + exit 124, missing command → validation error, and
contract-resolution path (string and `{cmd,timeout}`).

### 3. CLI — `src/cli/commands/eval.ts` (new)

```
grove eval <cid>                       # cmd from contract.hooks.eval
grove eval --frontier <metric>         # target = frontier byMetric[metric][0].cid
grove eval --latest                    # target = logOperation({limit:1}).results[0].cid
grove eval <cid> --eval-command "..."  # override command
grove eval <cid> --submit              # eval, then reproduceOperation with parsed scores
grove eval <cid> --timeout <ms>
grove eval <cid> --json
```

`parseEvalArgs` (pure, unit-tested) + `runEval` (resolves grove dir / stores / contract / agent,
mirrors `reproduce.ts` wiring) + `handleEval`.

Target-CID resolution precedence: positional `<cid>` → `--frontier <metric>` (via
`frontierOperation`, take `byMetric[metric][0]`; error if metric absent/empty) → `--latest`
(via `logOperation({limit:1})`; error if no contributions). Exactly one selector required.

Command resolution: `--eval-command` → `contract.hooks.eval` (passed through `deps.contract`
to the op) → validation error.

`--submit`: after a successful eval, convert parsed `EvalScore[]` → `Record<string, Score>`
using contract metric directions (`contract.metrics[name]?.direction ?? Maximize`, same as
`reproduce.ts`), then call `reproduceOperation({ targetCid, summary, result: "confirmed",
scores, tags, agent })`. Default summary: `"Eval of <cid>: <metric=value, ...>"`. Submit only
when `exitCode === 0`; otherwise print scores + nonzero exit and skip submission (note it).

Human output: list `metric = value` lines, exit code, timed-out flag; `--json` emits the full
`EvalResult` (plus reproduction cid when `--submit`).

Wire-up: `main.ts` dispatch block (lazy `import("./commands/eval.js")`), `printUsage` help
line, `registry.ts` `COMMANDS` entry with flags
`["frontier","latest","eval-command","submit","timeout","json"]`.

### 4. Preset — `src/cli/presets/eval-loop.ts` (new)

Hive-style competitive benchmark:

```ts
{
  name: "eval-loop",
  description: "Competitive benchmark loop with score:maximize",
  mode: "evaluation",
  metrics: [{ name: "score", direction: "maximize", description: "Benchmark score" }],
  topology: {
    structure: "graph",
    roles: [{
      name: "competitor",
      description: "Iterates to improve the benchmark score",
      maxInstances: 8,
      edges: [],
      command: "claude --role competitor",
    }],
    spawning: { dynamic: true, maxDepth: 1 },
  },
  gates: [{ type: "metric_improves", metric: "score" }],
  stopConditions: {
    maxRoundsWithoutImprovement: 20,
    targetMetric: { metric: "score", value: 1.0 },
    budget: { maxContributions: 2000, maxWallClockSeconds: 86400 },
  },
  hooks: { eval: "bash eval/eval.sh" },   // placeholder, emitted into GROVE.md
  // concurrency/execution/services/backend/features mirror research-loop
}
```

Register in `presets/index.ts` (`getPresetRegistry`, the `export {}` block). The preset declares
`hooks.eval`, so `grove init --preset eval-loop` writes a GROVE.md whose eval hook a benchmark
script fills in.

`renderHooks` in `src/cli/grove-md-builder.ts` currently emits only
`after_checkout/before_contribute/after_contribute` — add an `eval:` line so the placeholder
reaches the generated GROVE.md. (`HooksConfig` in the builder uses camelCase `afterCheckout`
etc.; add `evalCmd`/`eval` field accordingly and thread it through `presetToGroveMdConfig`.)

### 5. Surfaces / parity

- `docs/parity-matrix.md`: add row `| eval | Y | Y | - | - | shared |`.
- `parity-matrix.test.ts`: add `evalOperation` to the index-export list, `{operation:
  "evalOperation", cliCommand: "eval"}` to the CLI list, and `{operation: "evalOperation",
  mcpTool: "grove_eval"}` to the MCP list. This is the CI gate that keeps surfaces in sync.

## Deliberate non-goals (this iteration)

- **JSON-stdout protocol / `GROVE_EVAL_DIR` / `GROVE_EVAL_CID`** — superseded by the shipped
  `GROVE_SCORE` + `GROVE_TARGET_CID` design.
- **Artifact checkout into a workspace** — eval runs against the agent's current working tree
  (which already holds the modified artifacts); `targetCid` is the link/reference, passed as
  `GROVE_TARGET_CID`. Evaluating a non-working-tree CID requires a prior `grove checkout <cid>`.
- **MCP `--submit`** — `grove_eval` returns scores; agents call `grove_reproduce` separately.
  Keeps the MCP tool a pure, side-effect-free scorer.

These are recorded so a future iteration can revisit JSON-stdout / checkout if real eval
scripts need them.

## Testing

- `src/core/operations/eval.test.ts` — parsing, timeout, validation, contract resolution.
- `src/cli/commands/eval.test.ts` — arg parsing (selectors mutually exclusive, score/flag
  validation), and `runEval` against in-memory SQLite stores (frontier/latest resolution,
  `--submit` creates a reproduction).
- `src/cli/presets/preset-integration.test.ts` — picks up `eval-loop` registration; assert it
  builds a valid GROVE.md with the eval hook.
- `parity-matrix.test.ts` — CI gate (CLI + MCP + export coverage).

Full suite + typecheck + biome must pass before PR.
