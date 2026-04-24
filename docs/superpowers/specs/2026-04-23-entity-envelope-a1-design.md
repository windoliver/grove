# A1: Entity<Kind, Spec, Status> Envelope — Design

- **Issue**: [#287](https://github.com/windoliver/grove/issues/287)
- **Epic**: [#282](https://github.com/windoliver/grove/issues/282) — Foundation: Entity Model + Watch Protocol
- **Date**: 2026-04-23

## Goal

Introduce a Kubernetes-style `Entity<Kind, Spec, Status>` envelope as the uniform
wrapper for all persisted domain objects in Grove. Land it in a way that is
small enough to ship in a single PR and does not block the rest of the
contribution/claim/session surface from continuing to evolve.

The three existing kinds — Contribution, Claim, AgentSession — are wrapped via
pure adapter functions. Stores are untouched. A later issue (#291 — migration
tool) and the watch-protocol work (#292–#294) will move stores to Entity-native
return types.

## Non-goals

- Changing any store interface.
- Producing conditions from real controllers (that is Epic D, #285).
- Enforcing namespace/project isolation (that is #290).
- Replacing `Contribution` / `Claim` / `AgentSession` with the envelope at call sites.

## Strategy: parallel wrappers + derived conditions

- Keep existing flat types (`Contribution`, `Claim`, `AgentSession`) exactly as
  they are today.
- Add an `Entity<K, Spec, Status>` envelope type and three adapter functions
  that derive an Entity view from each flat type.
- Conditions are derived in the adapter (pure function of input). No store
  writes conditions today.
- The TUI detail panel calls the adapter once per render and shows conditions
  as colored chips.

This satisfies the acceptance criteria while keeping the blast radius at two
new source files, two new test files, and one existing view file.

## Types

All in `src/core/entity.ts`.

### Envelope

```ts
export type ConditionStatus = "True" | "False" | "Unknown";

export interface Condition {
  readonly type: string;
  readonly status: ConditionStatus;
  readonly observedGeneration: number;
  readonly lastTransitionTime: string;
  readonly reason: string;
  readonly message: string;
}

export interface OwnerRef {
  readonly kind: string;
  readonly id: string;
}

export interface EntityMetadata {
  readonly generation: number;
  readonly creationTimestamp?: string | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
  readonly ownerRefs?: readonly OwnerRef[] | undefined;
}

export interface Entity<K extends string, Spec, Status> {
  readonly kind: K;
  readonly namespace: string;
  readonly id: string;
  readonly spec: Spec;
  readonly status: Status;
  readonly conditions: readonly Condition[];
  readonly observedGeneration: number;
  readonly resourceVersion: string;
  readonly metadata: EntityMetadata;
}
```

### Per-kind projections

**Contribution** (immutable — status is empty, single `Published` condition).

```ts
export interface ContributionSpec {
  readonly contributionKind: ContributionKind;
  readonly mode: ContributionMode;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly commitHash?: string | undefined;
  readonly relations: readonly Relation[];
  readonly scores?: Readonly<Record<string, Score>> | undefined;
  readonly tags: readonly string[];
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent: AgentIdentity;
}

export type ContributionStatus = Record<string, never>;
export type ContributionEntity =
  Entity<"Contribution", ContributionSpec, ContributionStatus>;
```

Adapter rules:
- `id = c.cid`
- `namespace = "default"`
- `resourceVersion = "0"`
- `observedGeneration = 0`
- `metadata.generation = 1`
- `metadata.creationTimestamp = c.createdAt`
- Conditions: `[Published=True]` with `reason="Created"`, `lastTransitionTime = c.createdAt`.

Note on the envelope's `kind` vs `spec.contributionKind`: the envelope kind is
the type-level discriminant (`"Contribution"`), while the contribution's
domain-level kind (`work`/`review`/…) lives inside the spec. Renaming the
nested field to `contributionKind` avoids the ergonomic clash at the Entity
call-site.

**Claim** (mutable; revision → RV).

```ts
export interface ClaimSpec {
  readonly targetRef: string;
  readonly agent: AgentIdentity;
  readonly intentSummary: string;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface ClaimStatusBody {
  readonly phase: ClaimStatus; // existing "active" | "released" | "expired" | "completed"
  readonly heartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly attemptCount: number;
}

export type ClaimEntity = Entity<"Claim", ClaimSpec, ClaimStatusBody>;
```

Adapter rules:
- `id = c.claimId`
- `namespace = "default"`
- `resourceVersion = String(c.revision ?? 0)`
- `observedGeneration = c.revision ?? 0`
- `metadata.generation = c.revision ?? 1`
- `metadata.creationTimestamp = c.createdAt`
- Conditions derived from `c.status`:
  - `Active`: `status="True"` iff phase is `"active"`, else `"False"`. `reason = phase`. `lastTransitionTime = c.heartbeatAt`.
  - `Expired`: `status="True"` iff phase is `"expired"`, else `"False"`. `lastTransitionTime = c.leaseExpiresAt`.
  - `Completed`: `status="True"` iff phase is `"completed"`, else `"False"`. `lastTransitionTime = c.heartbeatAt`.

**AgentSession**.

```ts
export interface AgentSessionSpec {
  readonly role: string;
  readonly platform?: AgentPlatformType | undefined;
  readonly model?: string | undefined;
  readonly agent?: string | undefined;
}

export interface AgentSessionStatusBody {
  readonly phase: "running" | "idle" | "stopped" | "crashed";
  readonly pid?: number | undefined;
}

export type AgentSessionEntity =
  Entity<"AgentSession", AgentSessionSpec, AgentSessionStatusBody>;
```

Adapter rules:
- `id = s.id`
- `namespace = "default"`
- `resourceVersion = "0"`
- `observedGeneration = 0`
- `metadata.generation = 1`
- `metadata.creationTimestamp` omitted — `AgentSession` has no creation timestamp today.
- Conditions:
  - `Ready`: `status="True"` iff phase ∈ {`running`, `idle`}, else `"False"`. `reason = phase`.
  - `Crashed`: `status="True"` iff phase is `"crashed"`, else `"False"`. `reason = phase`.
  - `lastTransitionTime` for both conditions uses a caller-supplied clock: `agentSessionToEntity(s, now = () => new Date().toISOString())`. The default reads wall-clock; tests pass a fixed clock. This is a placeholder until the runtime tracks transition timestamps (Epic D).

The Contribution and Claim adapters do not need a clock parameter because their
`lastTransitionTime` sources (`createdAt`, `heartbeatAt`, `leaseExpiresAt`) are
already present on the input record.

## TUI integration

**New component** — `src/tui/components/condition-chips.tsx`.

- Props: `{ conditions: readonly Condition[] }`.
- Renders each condition as a single Ink `<Text>` chip.
- Color mapping:
  - `status === "True"` → green background
  - `status === "False"` → red background
  - `status === "Unknown"` → yellow background
- Chip text is `condition.type`. A line below the chip row renders `reason` for
  any chip with `status !== "True"`, so the user can read the failure cause
  without a hover affordance.

**Edit** — `src/tui/views/detail.tsx`.

- At the top of the rendered view, call `contributionToEntity(detail.contribution)`.
- Insert a `<ConditionChips conditions={entity.conditions}/>` row above the
  existing metadata block. Leave the rest of the view unchanged.
- No provider changes required — the adapter runs purely client-side.

## Tests

- `src/core/entity.test.ts` — adapter unit tests:
  - Contribution: published condition is always True, `id === cid`, creation timestamp passes through.
  - Claim: 4 phases × 3 condition types matrix; `revision` → `resourceVersion` and `observedGeneration`.
  - AgentSession: 4 phases → Ready/Crashed matrix; `id` pass-through; pid carried on status.
- `src/tui/components/condition-chips.test.ts` — prop-contract + color-mapping tests (pure logic, no renderer — matches `empty-state.test.ts` pattern).
- TDD order: adapters → chips component → detail view integration.

## Files

**New**

- `src/core/entity.ts`
- `src/core/entity.test.ts`
- `src/tui/components/condition-chips.tsx`
- `src/tui/components/condition-chips.test.ts`

**Edited**

- `src/core/index.ts` — re-export the Entity types and adapters.
- `src/tui/views/detail.tsx` — call `contributionToEntity` and mount `<ConditionChips/>`.

**Unchanged** — all store interfaces, server routes, MCP tools, CLI, remote
provider, nexus providers.

## Risks and open points

- The AgentSession adapter takes a `now` clock parameter because the runtime
  does not track transition times today. Tests inject a fixed clock; callers
  default to wall-clock. This must be revisited when Epic D (#285) introduces
  controllers that record real transition timestamps.
- `namespace = "default"` is a placeholder until #290 lands server-enforced
  isolation. The adapter is the one place that hardcodes it, so #290 can
  replace the single call-site value.
- The acceptance line "3 existing stores return Entity-shaped objects" is
  interpreted loosely here: the adapters are the Entity projection, and any
  consumer that wants entities calls the adapter against a store result.
  Dedicated `listEntities` methods on store interfaces are deferred to A7
  (#294, informer client) where they compose cleanly with the watch protocol.
