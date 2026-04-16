# PolicyEnforcer + EnforcingStore Read Config from Session

**Issue:** [#199](https://github.com/windoliver/grove/issues/199)
**Depends on:** #198 (merged — sessions already snapshot full GroveContract)
**Date:** 2026-04-15

## Problem

PolicyEnforcer, EnforcingStore, and evaluateStopConditions are hard-coupled to `GroveContract`. All sessions share a single GROVE.md config, so mid-session contract edits can break running sessions and there is no way to run sessions with different configs.

## Solution

Refactor these consumers to accept `SessionRuntimeConfig` (a `Pick<GroveContract, ...>` that already exists from #198) instead of `GroveContract`. Callers resolve config from the session record first, falling back to the contract for sessions created before #198.

## Approach

**Selected: Narrow constructor types to `SessionRuntimeConfig`**

`SessionRuntimeConfig` (defined in `src/core/session-config.ts`) is:

```typescript
type SessionRuntimeConfig = Pick<
  GroveContract,
  | "mode" | "metrics" | "gates" | "stopConditions"
  | "agentConstraints" | "concurrency" | "execution"
  | "outcomePolicy" | "evaluation" | "rateLimits"
  | "hooks" | "topology"
>;
```

Since this is a `Pick` of `GroveContract`, any `GroveContract` value structurally satisfies `SessionRuntimeConfig`. Backward compatibility is free — no runtime migration needed.

**Rejected alternatives:**
- Per-consumer narrow interfaces (PolicyConfig, StoreConfig) — over-engineered for three consumers.
- Pass full GroveContract sourced from session — doesn't decouple consumers from the contract type.

## Changes

### 1. PolicyEnforcer (`src/core/policy-enforcer.ts`)

**Constructor:**
```typescript
// Before
constructor(contract: GroveContract, store: ContributionStore, outcomeStore?: OutcomeStore)

// After
constructor(config: SessionRuntimeConfig, store: ContributionStore, outcomeStore?: OutcomeStore)
```

- Rename internal `this.contract` to `this.config`.
- All field access (metrics, gates, stopConditions, agentConstraints, outcomePolicy, evaluation) stays identical — all are fields of `SessionRuntimeConfig`.
- Update import: add `SessionRuntimeConfig`, remove `GroveContract` if unused.

### 2. EnforcingContributionStore (`src/core/enforcing-store.ts`)

**Constructor:**
```typescript
// Before
constructor(inner: ContributionStore, contract: GroveContract, options?)

// After
constructor(inner: ContributionStore, config: SessionRuntimeConfig, options?)
```

- Rename internal `this.contract` to `this.config`.
- Fields accessed: rateLimits, execution (via EnforcingClaimStore), concurrency — all in `SessionRuntimeConfig`.

### 3. EnforcingClaimStore (`src/core/enforcing-store.ts`)

**Constructor:**
```typescript
// Before
constructor(inner: ClaimStore, contract: GroveContract, options?)

// After
constructor(inner: ClaimStore, config: SessionRuntimeConfig, options?)
```

- Rename internal `this.contract` to `this.config`.
- Fields accessed: execution, concurrency — all in `SessionRuntimeConfig`.

### 4. evaluateStopConditions (`src/core/stop-conditions.ts`)

**Signature:**
```typescript
// Before
evaluateStopConditions(contract: GroveContract, store: ContributionStore)

// After
evaluateStopConditions(config: SessionRuntimeConfig, store: ContributionStore)
```

- Reads stopConditions and metrics — both in `SessionRuntimeConfig`.

### 5. Caller resolution (`src/core/operations/contribute.ts`)

Where PolicyEnforcer and EnforcingStore are instantiated, resolve config from session:

```typescript
import { getSessionRuntimeConfig } from "../session-config.js";

const config = getSessionRuntimeConfig(session) ?? deps.contract;
const enforcer = new PolicyEnforcer(config, deps.contributionStore, deps.outcomeStore);
```

`getSessionRuntimeConfig()` already exists from #198. If the session has a config snapshot, use it. Otherwise fall back to the global contract.

### 6. Server routes (`src/server/routes/contributions.ts`)

Same pattern — resolve session config before passing to PolicyEnforcer. The attach/enforce endpoint already re-runs enforcement; it should use session config.

### 7. OperationDeps (`src/core/operations/deps.ts`)

No structural change. `deps.contract` remains available as the fallback source. Callers do the `session.config ?? deps.contract` resolution before passing to consumers.

## Backward Compatibility

- `GroveContract` satisfies `SessionRuntimeConfig` structurally (it's a Pick). Callers passing a raw contract still compile.
- Sessions without config (created before #198) fall back to `deps.contract` via `getSessionRuntimeConfig(session) ?? deps.contract`.
- No runtime migration needed. No database changes.

## Files Changed

| File | Change |
|------|--------|
| `src/core/policy-enforcer.ts` | Constructor type + internal rename |
| `src/core/enforcing-store.ts` | Constructor types (both classes) + internal rename |
| `src/core/stop-conditions.ts` | Function signature |
| `src/core/operations/contribute.ts` | Resolve config from session |
| `src/server/routes/contributions.ts` | Resolve config from session |
| `src/core/policy-enforcer.test.ts` | Update test instantiation |
| `src/core/enforcing-store.test.ts` | Update test instantiation |
| `src/core/stop-conditions.test.ts` | Update test instantiation |

## Testing

- Existing test suites for PolicyEnforcer (67 tests), EnforcingStore, and stop-conditions pass with `SessionRuntimeConfig` instead of `GroveContract` — no behavioral change.
- Add test: PolicyEnforcer with session config that differs from contract verifies session config wins.
- Add test: Fallback when session has no config uses contract.
- Add test: EnforcingStore rate limits use session config, not contract.

## Out of Scope

- SessionOrchestrator changes — it already snapshots config on session creation (#198).
- Lifecycle state derivation — `deriveLifecycleState()` is graph-only, doesn't read contract.
- New SessionConfig interfaces — `SessionRuntimeConfig` already covers all needed fields.
