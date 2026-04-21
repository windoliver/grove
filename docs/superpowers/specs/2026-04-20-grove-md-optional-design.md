# Make GROVE.md Optional — TUI Works Without It

**Issue:** [#200](https://github.com/windoliver/grove/issues/200)
**Depends on:** #198 (merged — sessions snapshot full `GroveContract`), #199 (merged — PolicyEnforcer/EnforcingStore read from session config)
**Date:** 2026-04-20

## Problem

Today you cannot start a grove without `GROVE.md`. After #198/#199, sessions carry the full config snapshot, and `PolicyEnforcer`/`EnforcingStore` read from that snapshot — so `GROVE.md` is no longer load-bearing for enforcement. Two surfaces still block bare groves:

1. `grove init` always writes `GROVE.md` (with or without a preset).
2. `POST /api/sessions` returns 501 `NOT_CONFIGURED` when no contract is loaded on the server.

The rest of the stack already tolerates a missing `GROVE.md`:

| Surface | Current behavior |
|---|---|
| `grove session start` (CLI) | `resolveContract()` returns `undefined` on ENOENT; `--preset` / `--roles` already drive topology |
| TUI `loadContract()` | returns `undefined` gracefully; TUI proceeds |
| MCP server | skips contract parse in Nexus mode |
| Server bootstrap (`createLocalRuntime`) | `existsSync` gate → `runtime.contract = undefined`; boot succeeds |
| `PolicyEnforcer` / `EnforcingStore` | read `SessionRuntimeConfig` from session (#199) |

## Solution

- `grove init` (no `--preset`): create `.grove/` with `grove.db` and `grove.json`, **do not write `GROVE.md`**.
- `grove init --preset X`: unchanged — writes `GROVE.md` from preset as a convenience (human-readable project defaults).
- `POST /api/sessions` without a loaded contract: resolve the session config from `body.preset` server-side via the preset registry. If neither contract nor preset is available, return 400.
- TUI: unchanged (preset picker already required; Task 6 is satisfied because the preset path still writes `GROVE.md`).
- Server bootstrap: unchanged code; add a one-line startup INFO log when `runtime.contract === undefined` for operator clarity.

## Approach

**Selected:** preset-resolved session config on the server when no `GROVE.md` is loaded.

Presets already carry the full config (`mode`, `metrics`, `gates`, `stopConditions`, `agentConstraints`, `concurrency`, `execution`, `topology`). The server-side resolution re-uses the existing `getPreset(name)` registry. No schema surface is added to `createSessionSchema` for inline full-config injection.

**Rejected alternatives:**
- Extending `createSessionSchema` with inline `metrics` / `gates` / etc. — large surface; not required by #200; revisit if a future client needs it.
- Silent server-side synthesis of minimal defaults when no contract and no preset — hides misconfiguration. Explicit 400 is clearer.
- Keeping the `defaultGroveMdConfig` path (writing a stub `GROVE.md` on bare init) — contradicts Task 1 wording ("no GROVE.md required").

## Changes

### 1. `src/cli/commands/init.ts`

Guard the GROVE.md write on preset presence.

```typescript
// Before (always writes)
progress(3, "Generating GROVE.md contract");
const grovemdPath = join(options.cwd, "GROVE.md");
const mdConfig = preset
  ? presetToGroveMdConfig(preset, options)
  : defaultGroveMdConfig(options);
const grovemdContent = buildGroveMd(mdConfig);
await writeFile(grovemdPath, grovemdContent, "utf-8");

// After
if (preset) {
  progress(3, "Generating GROVE.md contract");
  const grovemdPath = join(options.cwd, "GROVE.md");
  const grovemdContent = buildGroveMd(presetToGroveMdConfig(preset, options));
  await writeFile(grovemdPath, grovemdContent, "utf-8");
}
// No preset → skip the GROVE.md write entirely.
```

- Remove the `defaultGroveMdConfig` import if it has no remaining callers; otherwise leave it.
- `progress(3, ...)` is emitted only on the preset path — step numbering for the bare path skips "Generating GROVE.md contract". Verify no CLI output assertion depends on the literal sequence.
- `grove.json` is written unconditionally (unchanged). `preset: undefined` is persisted when no preset is given.
- `inferNexusPreset({ preset: undefined, ... })` must continue to return a sane default — verify during implementation; patch if not.

### 2. `src/cli/presets/index.ts`

Add `presetToSessionConfig(preset: PresetConfig, name: string): GroveContract`.

```typescript
export function presetToSessionConfig(
  preset: PresetConfig,
  name: string,
): GroveContract {
  // Maps preset fields (mode, metrics, gates, stopConditions,
  // agentConstraints, concurrency, execution, topology, outcomePolicy,
  // evaluation, rateLimits, hooks) into a GroveContract-shaped object.
  // Mirrors the round-trip that `buildGroveMd` -> `parseGroveContract`
  // would produce, but skips the markdown pass.
  // Fields not carried by the preset (contractVersion, name, description)
  // come from the caller or sensible defaults.
}
```

- Lives in `src/cli/presets/index.ts` — the only module that owns the full `PresetConfig` shape. Placing it in `src/core/presets.ts` would invert the existing cli → core dependency direction.
- Server imports from `src/cli/presets/index.ts`. `src/tui/main.ts:186` already does this, so the pattern is established.
- `name` is passed in because `GroveContract.name` is grove-level, not preset-level (the preset's own `name` field is the preset ID like `"review-loop"`).

### 3. `src/server/routes/sessions.ts`

Rewrite the `!contract` branch. Also update the schema's error wording.

```typescript
// Resolve base config: session.config snapshot source.
let baseConfig: GroveContract | undefined;
if (contract) {
  baseConfig = contract;
} else if (presetName) {
  const preset = getPreset(presetName);
  if (!preset) {
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: `Unknown preset '${presetName}'` } },
      400,
    );
  }
  baseConfig = presetToSessionConfig(preset, presetName);
} else {
  return c.json(
    {
      error: {
        code: "VALIDATION_ERROR",
        message: "contract or preset required when no GROVE.md is loaded",
      },
    },
    400,
  );
}

// Resolve topology (unchanged) and merge.
const sessionConfig = resolvedTopology
  ? { ...baseConfig, topology: resolvedTopology }
  : baseConfig;
```

- Delete the prior 501 `NOT_CONFIGURED` response path.
- Import `getPreset` from `src/cli/presets/index.ts`. The TUI (`src/tui/main.ts:186`) and core tests already import from this module, so the server doing the same is consistent.
- `resolvedTopology` continues to override `baseConfig.topology` so per-session TUI edits (e.g. `replyTimeoutSeconds`) still win.

### 4. `src/server/serve.ts`

Add one INFO log at bootstrap so operators can tell the grove is contract-less on purpose.

```typescript
if (!runtime.contract) {
  console.log(
    "no GROVE.md found — sessions must provide a preset or a loaded contract",
  );
}
```

No behavioral change beyond logging.

### 5. `src/tui/main.ts`

No code change. TUI preset picker already supplies a preset to `executeInit`; the bare-init path is CLI-only.

### 6. `src/local/runtime.ts`

No change. `createLocalRuntime` already uses `existsSync` before reading `GROVE.md` and leaves `contract` undefined on ENOENT.

## Backward Compatibility

- **Existing groves with `GROVE.md`:** unchanged. `runtime.contract` is loaded from disk; all routes continue to use it.
- **Existing groves without `GROVE.md`:** previously broken on `POST /api/sessions`; now succeed when a preset is provided.
- **`grove init` users who rely on the current default `GROVE.md`:** behavior changes silently. The `defaultGroveMdConfig` stub is no longer produced; callers who want a project-level contract must pass `--preset <name>` from the existing registry (`exploration`, `federated-swarm`, `pr-review`, `research-loop`, `review-loop`, `swarm-ops`). There is no `default` preset — `README.md` and the CLI `--help` must state this explicitly.
- **`grove init --force` over a dir with a user-authored `GROVE.md` and no `--preset`:** we never write `GROVE.md` on the bare path, so the user file is left untouched. This is safer than the current behavior (which overwrites the user file with the default stub).
- No database migration. `session.config_json` shape is unchanged.
- No wire-format change. `createSessionSchema` is unchanged.

## Files Changed

| File | Change |
|------|--------|
| `src/cli/commands/init.ts` | Guard GROVE.md write on preset; drop unconditional `defaultGroveMdConfig` path |
| `src/cli/presets/index.ts` | Add `presetToSessionConfig(preset, name)` helper |
| `src/server/routes/sessions.ts` | Resolve `baseConfig` from contract or preset; 400 on neither; delete 501 branch |
| `src/server/serve.ts` | Add bootstrap INFO log when `runtime.contract` is undefined |
| `tests/cli/init-bare.test.ts` (new) | Bare-init creates no GROVE.md; `grove.db` and `grove.json` present |
| `tests/server/routes/sessions-no-contract.test.ts` (new) | Preset-only session creation succeeds without contract; 400 paths |
| `tests/cli/presets-to-session-config.test.ts` (new) | `presetToSessionConfig(preset, name)` produces a valid `GroveContract` |
| `tests/presets/preset-integration.test.ts` | Line 183/875 stay (still `--preset` paths); add bare-init sibling test |
| `tests/presets/preset-e2e-nexus.test.ts` | Line 197 stays (still `--preset` path) |
| `README.md` | GROVE.md-is-optional callout; `grove init` two-path example |

## Testing

**`tests/cli/init.test.ts` (new):**
- `grove init foo` → `.grove/grove.db` exists, `.grove/grove.json` exists, `GROVE.md` absent.
- `grove init foo --preset review-loop` → `.grove/...` plus `GROVE.md` exists and parses.
- `grove init --force` over a directory with a user-authored `GROVE.md` and no `--preset` → `GROVE.md` untouched.

**`tests/server/routes/sessions.test.ts`:**
- `POST /api/sessions` with `contract: undefined`, body `{ goal, preset: "review-loop" }` → 201; `session.config` snapshot contains `metrics` and `gates` from the preset.
- Same, body `{ goal }` → 400 `VALIDATION_ERROR` "contract or preset required".
- Same, body `{ goal, preset: "unknown-x" }` → 400 `VALIDATION_ERROR` "Unknown preset 'unknown-x'".
- With contract loaded, body unchanged → behavior identical to today.

**`tests/cli/presets-to-session-config.test.ts` (new):**
- `presetToSessionConfig(getPreset("review-loop"), "my-grove")` returns an object that structurally satisfies `GroveContract` and whose key fields (`name`, `mode`, `topology`, `concurrency`, `execution`) match the preset.
- `presetToSessionConfig(getPreset("review-loop"), "my-grove")` is equivalent (for fields both produce) to `parseGroveContract(buildGroveMd(presetToGroveMdConfig(getPreset("review-loop"), { name: "my-grove", ... })))` — key-field comparison, not byte-exact.

**Modify existing:**
- `tests/presets/preset-integration.test.ts:183,875` — assert GROVE.md exists under the `--preset` path only; add a bare-init sibling case asserting absence.
- `tests/presets/preset-integration.test.ts:828-830` — unchanged (preset path keeps parseable GROVE.md).
- `tests/presets/preset-e2e-nexus.test.ts:197` — split the same way.

**No PolicyEnforcer / EnforcingStore test changes** — session-driven config already covered by #199.

## Documentation

- **`README.md`:** add a "GROVE.md is optional" callout under Getting Started. Show both `grove init foo` (bare) and `grove init foo --preset review-loop` (with defaults). Note that presets carry full config per-session; GROVE.md is project-level defaults. Also update the line at `README.md:400` which currently says "`GROVE.md` is Grove's contract file, generated by `grove init`..." to reflect the preset-only generation.
- **No `docs/GROVE_MD.md` or `CHANGELOG.md`:** neither file exists in the repo (confirmed during implementation planning). Skip.
- **CLI `--help` for `grove init`:** reword the usage string in `src/cli/commands/init.ts:40-42` (JSDoc comment used by `--help` machinery) from "Creates a new grove with GROVE.md contract" → "Creates a new grove. Pass `--preset <name>` to also generate a `GROVE.md` with preset defaults."

## Out of Scope

- Inline full-config injection on `POST /api/sessions` (metrics/gates/etc. in the request body). Defer to a follow-up issue if a client needs it.
- Changing the `GROVE.md` format or schema. Format stays as-is for backward compat.
- Deleting `GROVE.md` support. It remains the canonical human-readable project defaults.
- A `--no-contract` or `--skip-grove-md` flag — unneeded because the preset flag already gates the write.
- TUI "skip preset" option — out of scope; TUI preset picker remains required.
- Migrating existing groves from `GROVE.md`-backed to preset-backed sessions. Existing groves keep working unchanged.
