# Claim Spec/Status Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #270 by splitting claim spec and status ownership in core contracts, SQLite storage, HTTP routes, and adapter stores while preserving legacy flat `Claim` compatibility.

**Architecture:** Add explicit `ClaimSpec`, `ClaimStatusRecord`, `ClaimStatusPatch`, and `ClaimView` DTOs to core models/store contracts, then make every `ClaimStore` implementation expose spec/status methods. SQLite physically stores `claim_spec` and `claim_status`; in-memory and Nexus enforce the same logical ownership while keeping their existing storage shape. Existing flat claim methods become compatibility adapters over the new split DTOs, and new Hono routes expose spec-only and controller-only status writes.

**Tech Stack:** TypeScript strict mode, Bun 1.3.x, `bun:test`, Hono, Zod, Bun SQLite, Nexus VFS adapter tests, Biome.

---

## File Structure

- Modify `src/core/models.ts` — add claim spec/status DTOs and keep legacy `Claim` type.
- Modify `src/core/store.ts` — extend `ClaimStore` with split methods and status patch type.
- Modify `src/core/entity.ts` — project richer spec/status fields from flat claims and claim views.
- Modify `src/core/claim-store.conformance.ts` — add backend-neutral spec/status ownership tests.
- Modify `src/core/reconciler.test.ts` — update local mock `ClaimStore` to implement new methods.
- Modify `src/server/test-helpers.ts` — update `InMemoryClaimStore` with split methods and controller-token test setup.
- Modify `tests/server/helpers.ts` — pass controller token through `ServerDeps` for route tests.
- Modify `tests/server/claims.test.ts` — add HTTP route tests for `PUT`, `GET`, and status subresource auth.
- Modify `src/server/deps.ts` — add optional `controllerToken`.
- Modify `src/server/serve.ts` — wire `GROVE_CONTROLLER_TOKEN` into `ServerDeps`.
- Modify `src/server/routes/claims.ts` — add spec/status schemas and new routes.
- Modify `src/local/sqlite-store.ts` — add split table DDL, migration backfill, row helpers, split methods, and legacy method rewrites.
- Modify `src/local/sqlite-store.migration.test.ts` — add split table and legacy backfill migration tests.
- Modify `src/local/sqlite-store.test.ts` — add SQLite adapter-specific split ownership tests for watch fan-out and route compatibility.
- Modify `src/nexus/nexus-claim-store.ts` — add logical split methods over existing claim JSON files.
- Modify `tests/nexus/unit/nexus-claim-store.test.ts` — rely on updated conformance and add one adapter-specific cache/status test.

## Environment Note

This worktree currently does not have `bun` on PATH. Before executing tests, install or expose Bun 1.3.x, then run `bun install` if `node_modules` is absent.

---

### Task 1: Core Claim DTOs and Store Contract

**Files:**
- Modify: `src/core/models.ts`
- Modify: `src/core/store.ts`
- Test: `src/core/claim-store.conformance.ts`

- [ ] **Step 1: Write failing conformance tests for split ownership**

Add these tests near the start of `runClaimStoreTests()` after `beforeEach`/`afterEach`, before the existing `createClaim / getClaim` section:

```ts
    test("putClaimSpec creates a claim view with default status", async () => {
      const now = new Date().toISOString();
      const view = await store.putClaimSpec({
        id: "spec-create",
        roleName: "coder",
        platform: "codex",
        blueprint: "implement issue",
        assignee: makeAgent({ agentId: "agent-spec", platform: "codex", role: "coder" }),
        leaseDeadlineSec: 600,
        priority: 7,
        maxIterations: 3,
        generation: 99,
        targetRef: "target-spec",
        agent: makeAgent({ agentId: "agent-spec", platform: "codex", role: "coder" }),
        intentSummary: "Implement claim split",
        context: { issue: 270 },
        createdAt: now,
      });

      expect(view.spec.id).toBe("spec-create");
      expect(view.spec.generation).toBe(1);
      expect(view.spec.roleName).toBe("coder");
      expect(view.status.id).toBe("spec-create");
      expect(view.status.phase).toBe(ClaimStatus.Active);
      expect(view.status.observedGeneration).toBe(0);
      expect(view.status.revision).toBe(1);
    });

    test("putClaimSpec increments generation without changing status revision", async () => {
      const created = await store.putClaimSpec({
        id: "spec-update",
        targetRef: "target-spec-update",
        agent: makeAgent({ agentId: "agent-spec-update" }),
        intentSummary: "first spec",
        createdAt: new Date().toISOString(),
        generation: 1,
      });
      const statusUpdated = await store.patchClaimStatus("spec-update", {
        phase: ClaimStatus.Active,
        observedGeneration: created.spec.generation,
        lastHeartbeatAt: "2026-01-01T00:01:00.000Z",
      });

      const updated = await store.putClaimSpec({
        ...statusUpdated.spec,
        intentSummary: "second spec",
        generation: 1,
      });

      expect(updated.spec.generation).toBe(created.spec.generation + 1);
      expect(updated.spec.intentSummary).toBe("second spec");
      expect(updated.status.revision).toBe(statusUpdated.status.revision);
      expect(updated.status.lastHeartbeatAt).toBe(statusUpdated.status.lastHeartbeatAt);
    });

    test("patchClaimStatus changes status without changing spec generation", async () => {
      const created = await store.putClaimSpec({
        id: "status-update",
        targetRef: "target-status-update",
        agent: makeAgent({ agentId: "agent-status-update" }),
        intentSummary: "status-only write",
        createdAt: "2026-01-01T00:00:00.000Z",
        generation: 1,
      });

      const patched = await store.patchClaimStatus("status-update", {
        phase: ClaimStatus.Completed,
        observedGeneration: created.spec.generation,
        agentSessionId: "session-1",
        lastHeartbeatAt: "2026-01-01T00:05:00.000Z",
        leaseExpiresAt: "2026-01-01T00:10:00.000Z",
        currentContributionCid:
          "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        conditions: [
          {
            type: "Completed",
            status: "True",
            observedGeneration: created.spec.generation,
            lastTransitionTime: "2026-01-01T00:05:00.000Z",
            reason: "controller",
            message: "done",
          },
        ],
        lastTransitionAt: "2026-01-01T00:05:00.000Z",
      });

      expect(patched.spec.generation).toBe(created.spec.generation);
      expect(patched.spec.intentSummary).toBe(created.spec.intentSummary);
      expect(patched.status.phase).toBe(ClaimStatus.Completed);
      expect(patched.status.observedGeneration).toBe(created.spec.generation);
      expect(patched.status.agentSessionId).toBe("session-1");
      expect(patched.status.revision).toBe(created.status.revision + 1);
      expect(patched.status.conditions[0]?.type).toBe("Completed");
    });

    test("getClaimView returns undefined for a missing claim", async () => {
      await expect(store.getClaimView("missing-view")).resolves.toBeUndefined();
    });
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
bun test src/local/sqlite-store.test.ts tests/nexus/unit/nexus-claim-store.test.ts
```

Expected: TypeScript/test failure because `ClaimStore` does not have `putClaimSpec`, `patchClaimStatus`, or `getClaimView`.

- [ ] **Step 3: Add core DTO types**

In `src/core/models.ts`, add this type-only import:

```ts
import type { Condition } from "./entity.js";
```

Then add this after the existing `Claim` interface:

```ts
/** User-owned desired state for a claim. */
export interface ClaimSpecRecord {
  readonly id: string;
  readonly roleName?: string | undefined;
  readonly platform?: string | undefined;
  readonly blueprint?: string | undefined;
  readonly assignee?: AgentIdentity | undefined;
  readonly leaseDeadlineSec?: number | undefined;
  readonly priority?: number | undefined;
  readonly maxIterations?: number | undefined;
  readonly generation: number;
  readonly targetRef: string;
  readonly agent: AgentIdentity;
  readonly intentSummary: string;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly createdAt: string;
}

/** Controller-owned observed state for a claim. */
export interface ClaimStatusRecord {
  readonly id: string;
  readonly phase: ClaimStatus;
  readonly observedGeneration: number;
  readonly agentSessionId?: string | undefined;
  readonly lastHeartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly currentContributionCid?: string | undefined;
  readonly conditions: readonly Condition[];
  readonly lastTransitionAt: string;
  readonly attemptCount: number;
  readonly revision: number;
}

/** Merged split claim view. */
export interface ClaimView {
  readonly spec: ClaimSpecRecord;
  readonly status: ClaimStatusRecord;
}
```

- [ ] **Step 4: Add status patch and store methods**

In `src/core/store.ts`, update the model import to include `ClaimSpecRecord`, `ClaimStatusRecord`, and `ClaimView`, and add this type-only import:

```ts
import type { Condition } from "./entity.js";
```

Then add this interface before `ClaimStore`:

```ts
/** Status-only patch accepted by controller-owned claim status writes. */
export interface ClaimStatusPatch {
  readonly phase?: ClaimStatus | undefined;
  readonly observedGeneration?: number | undefined;
  readonly agentSessionId?: string | undefined;
  readonly lastHeartbeatAt?: string | undefined;
  readonly leaseExpiresAt?: string | undefined;
  readonly currentContributionCid?: string | undefined;
  readonly conditions?: readonly Condition[] | undefined;
  readonly lastTransitionAt?: string | undefined;
}
```

Then add these methods to `ClaimStore` immediately after `readonly storeIdentity?: string | undefined;`:

```ts
  /** Create or update user-owned claim spec. Store controls generation. */
  putClaimSpec(spec: ClaimSpecRecord): Promise<ClaimView>;

  /** Get the merged split claim view by ID. */
  getClaimView(claimId: string): Promise<ClaimView | undefined>;

  /** Patch controller-owned claim status fields only. */
  patchClaimStatus(claimId: string, patch: ClaimStatusPatch): Promise<ClaimView>;
```

- [ ] **Step 5: Run tests to verify RED moved to implementations**

Run:

```bash
bun test src/local/sqlite-store.test.ts tests/nexus/unit/nexus-claim-store.test.ts
```

Expected: TypeScript failures in `SqliteClaimStore`, `InMemoryClaimStore`, Nexus test mocks, and `NexusClaimStore` because they do not implement the new methods.

- [ ] **Step 6: Commit**

```bash
git add src/core/models.ts src/core/store.ts src/core/claim-store.conformance.ts
git commit -m "feat: add claim spec status store contract"
```

---

### Task 2: Shared Conversion Helpers

**Files:**
- Modify: `src/core/models.ts`
- Modify: `src/core/entity.ts`
- Test: `src/core/entity.test.ts`

- [ ] **Step 1: Write failing entity projection test**

In `src/core/entity.test.ts`, add this test in the claim entity section:

```ts
  test("claimToEntity projects split-compatible spec and status fields", () => {
    const claim = makeClaim({
      claimId: "claim-rich",
      targetRef: "target-rich",
      agent: {
        agentId: "agent-rich",
        platform: "codex",
        role: "coder",
      },
      intentSummary: "rich claim",
      context: { issue: 270 },
      createdAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:01:00.000Z",
      leaseExpiresAt: "2026-01-01T00:06:00.000Z",
      revision: 4,
    });

    const entity = claimToEntity(claim, () => Date.parse("2026-01-01T00:02:00.000Z"), "ns/test");

    expect(entity.spec.roleName).toBe("coder");
    expect(entity.spec.platform).toBe("codex");
    expect(entity.spec.assignee).toEqual(claim.agent);
    expect(entity.spec.leaseDeadlineSec).toBe(360);
    expect(entity.status.observedGeneration).toBe(4);
    expect(entity.status.lastHeartbeatAt).toBe("2026-01-01T00:01:00.000Z");
    expect(entity.status.leaseExpiresAt).toBe("2026-01-01T00:06:00.000Z");
    expect(entity.metadata.generation).toBe(4);
  });
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
bun test src/core/entity.test.ts
```

Expected: FAIL because `ClaimEntity.spec` lacks `roleName`, `platform`, `assignee`, and `leaseDeadlineSec`, and status uses `heartbeatAt` rather than `lastHeartbeatAt`.

- [ ] **Step 3: Add conversion helpers**

In `src/core/models.ts`, after the new DTO interfaces, add these exported helpers:

```ts
/** Derive a split claim spec from a legacy flat claim snapshot. */
export function claimToSpecRecord(claim: Claim): ClaimSpecRecord {
  const createdMs = Date.parse(claim.createdAt);
  const expiresMs = Date.parse(claim.leaseExpiresAt);
  const leaseDeadlineSec =
    Number.isFinite(createdMs) && Number.isFinite(expiresMs) && expiresMs > createdMs
      ? Math.round((expiresMs - createdMs) / 1000)
      : undefined;
  return {
    id: claim.claimId,
    roleName: claim.agent.role,
    platform: claim.agent.platform,
    assignee: claim.agent,
    leaseDeadlineSec,
    generation: claim.revision ?? 1,
    targetRef: claim.targetRef,
    agent: claim.agent,
    intentSummary: claim.intentSummary,
    context: claim.context,
    createdAt: claim.createdAt,
  };
}

/** Derive a split claim status from a legacy flat claim snapshot. */
export function claimToStatusRecord(
  claim: Claim,
  conditions: readonly import("./entity.js").Condition[] = [],
): ClaimStatusRecord {
  const revision = claim.revision ?? 1;
  return {
    id: claim.claimId,
    phase: claim.status,
    observedGeneration: revision,
    lastHeartbeatAt: claim.heartbeatAt,
    leaseExpiresAt: claim.leaseExpiresAt,
    conditions,
    lastTransitionAt: claim.heartbeatAt,
    attemptCount: claim.attemptCount ?? 0,
    revision,
  };
}

/** Merge split claim records into the legacy flat claim shape. */
export function claimViewToClaim(view: ClaimView): Claim {
  const base: Claim = {
    claimId: view.spec.id,
    targetRef: view.spec.targetRef,
    agent: view.spec.agent,
    status: view.status.phase,
    intentSummary: view.spec.intentSummary,
    createdAt: view.spec.createdAt,
    heartbeatAt: view.status.lastHeartbeatAt,
    leaseExpiresAt: view.status.leaseExpiresAt,
    revision: view.status.revision,
  };
  return {
    ...base,
    ...(view.spec.context !== undefined ? { context: view.spec.context } : {}),
    ...(view.status.attemptCount > 0 ? { attemptCount: view.status.attemptCount } : {}),
  };
}
```

- [ ] **Step 4: Update entity projection**

In `src/core/entity.ts`, update `ClaimSpec`:

```ts
export interface ClaimSpec {
  readonly targetRef: string;
  readonly agent: AgentIdentity;
  readonly intentSummary: string;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly roleName?: string | undefined;
  readonly platform?: string | undefined;
  readonly blueprint?: string | undefined;
  readonly assignee?: AgentIdentity | undefined;
  readonly leaseDeadlineSec?: number | undefined;
  readonly priority?: number | undefined;
  readonly maxIterations?: number | undefined;
}
```

Update `ClaimStatusBody` to include aliases without removing existing fields:

```ts
  readonly heartbeatAt: string;
  readonly lastHeartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly currentContributionCid?: string | undefined;
  readonly agentSessionId?: string | undefined;
  readonly attemptCount: number;
```

In `claimToEntity`, add derived spec fields:

```ts
  const createdMs = Date.parse(c.createdAt);
  const expiresMs = Date.parse(c.leaseExpiresAt);
  const leaseDeadlineSec =
    Number.isFinite(createdMs) && Number.isFinite(expiresMs) && expiresMs > createdMs
      ? Math.round((expiresMs - createdMs) / 1000)
      : undefined;
```

Then update returned `spec` and `status`:

```ts
    spec: {
      targetRef: c.targetRef,
      agent: c.agent,
      intentSummary: c.intentSummary,
      context: c.context,
      roleName: c.agent.role,
      platform: c.agent.platform,
      assignee: c.agent,
      leaseDeadlineSec,
    },
    status: {
      phase: effectivePhase,
      persistedPhase,
      heartbeatAt: c.heartbeatAt,
      lastHeartbeatAt: c.heartbeatAt,
      leaseExpiresAt: c.leaseExpiresAt,
      attemptCount: c.attemptCount ?? 0,
    },
```

- [ ] **Step 5: Run test to verify GREEN**

Run:

```bash
bun test src/core/entity.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/models.ts src/core/entity.ts src/core/entity.test.ts
git commit -m "feat: add claim split conversion helpers"
```

---

### Task 3: In-Memory ClaimStore Split Methods

**Files:**
- Modify: `src/server/test-helpers.ts`
- Modify: `src/core/reconciler.test.ts`
- Test: `src/server/test-helpers.ts`
- Test: `src/core/reconciler.test.ts`
- Test: `src/local/sqlite-store.test.ts`
- Test: `tests/nexus/unit/nexus-claim-store.test.ts`

- [ ] **Step 1: Run compile to verify missing methods**

Run:

```bash
bun test src/core/reconciler.test.ts src/server/watch-wiring.test.ts
```

Expected: TypeScript failure because mock `ClaimStore` objects lack `putClaimSpec`, `getClaimView`, and `patchClaimStatus`.

- [ ] **Step 2: Implement InMemoryClaimStore split maps and methods**

In `src/server/test-helpers.ts`, update imports to include `ClaimSpecRecord`, `ClaimStatusPatch`, `ClaimStatusRecord`, `ClaimView`, `claimToSpecRecord`, `claimToStatusRecord`, and `claimViewToClaim` from `../core/models.js`.

Replace the private flat map:

```ts
  private readonly claims = new Map<string, Claim>();
```

with split maps:

```ts
  private readonly specs = new Map<string, ClaimSpecRecord>();
  private readonly statuses = new Map<string, ClaimStatusRecord>();
```

Add these helpers inside `InMemoryClaimStore` before `createClaim`:

```ts
  private toClaim(view: ClaimView): Claim {
    return claimViewToClaim(view);
  }

  private viewFor(claimId: string): ClaimView | undefined {
    const spec = this.specs.get(claimId);
    const status = this.statuses.get(claimId);
    if (spec === undefined || status === undefined) return undefined;
    return { spec, status };
  }

  private allViews(): ClaimView[] {
    const views: ClaimView[] = [];
    for (const id of this.specs.keys()) {
      const view = this.viewFor(id);
      if (view !== undefined) views.push(view);
    }
    return views;
  }

  private putView(view: ClaimView): void {
    this.specs.set(view.spec.id, view.spec);
    this.statuses.set(view.status.id, view.status);
  }

  async putClaimSpec(spec: ClaimSpecRecord): Promise<ClaimView> {
    const existing = this.viewFor(spec.id);
    const now = new Date().toISOString();
    const leaseDurationMs = (spec.leaseDeadlineSec ?? 300) * 1000;
    const nextSpec: ClaimSpecRecord = {
      ...spec,
      generation: existing === undefined ? 1 : existing.spec.generation + 1,
      createdAt: existing?.spec.createdAt ?? spec.createdAt,
    };
    const nextStatus: ClaimStatusRecord =
      existing?.status ?? {
        id: spec.id,
        phase: "active",
        observedGeneration: 0,
        lastHeartbeatAt: now,
        leaseExpiresAt: new Date(Date.parse(spec.createdAt) + leaseDurationMs).toISOString(),
        conditions: [],
        lastTransitionAt: now,
        attemptCount: 0,
        revision: 1,
      };
    const view: ClaimView = {
      spec: nextSpec,
      status: nextStatus,
    };
    this.putView(view);
    return view;
  }

  async getClaimView(claimId: string): Promise<ClaimView | undefined> {
    return this.viewFor(claimId);
  }

  async patchClaimStatus(claimId: string, patch: ClaimStatusPatch): Promise<ClaimView> {
    const view = this.viewFor(claimId);
    if (view === undefined) {
      throw new NotFoundError({
        resource: "Claim",
        identifier: claimId,
        message: `Claim ${claimId} does not exist`,
      });
    }
    const updated: ClaimView = {
      spec: view.spec,
      status: {
        ...view.status,
        phase: patch.phase ?? view.status.phase,
        observedGeneration: patch.observedGeneration ?? view.status.observedGeneration,
        agentSessionId: patch.agentSessionId ?? view.status.agentSessionId,
        lastHeartbeatAt: patch.lastHeartbeatAt ?? view.status.lastHeartbeatAt,
        leaseExpiresAt: patch.leaseExpiresAt ?? view.status.leaseExpiresAt,
        currentContributionCid: patch.currentContributionCid ?? view.status.currentContributionCid,
        conditions: patch.conditions ?? view.status.conditions,
        lastTransitionAt: patch.lastTransitionAt ?? view.status.lastTransitionAt,
        revision: view.status.revision + 1,
      },
    };
    this.putView(updated);
    return updated;
  }
```

Then rewrite legacy methods in the same class to use `viewFor`, `putView`, and `toClaim`. These are the important replacements:

```ts
  async createClaim(claim: Claim): Promise<Claim> {
    if (this.specs.has(claim.claimId)) {
      throw new StateConflictError({
        resource: "Claim",
        reason: "already exists",
        message: `Claim ${claim.claimId} already exists`,
      });
    }
    const created: ClaimView = {
      spec: { ...claimToSpecRecord(claim), generation: 1 },
      status: { ...claimToStatusRecord({ ...claim, revision: 1 }), observedGeneration: 0 },
    };
    this.putView(created);
    return this.toClaim(created);
  }

  async getClaim(claimId: string): Promise<Claim | undefined> {
    const view = this.viewFor(claimId);
    return view === undefined ? undefined : this.toClaim(view);
  }

  async listClaims(query?: ClaimQuery): Promise<readonly Claim[]> {
    let results = this.allViews().map((view) => this.toClaim(view));
    if (query?.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      results = results.filter((c) => statuses.includes(c.status));
    }
    if (query?.agentId) {
      results = results.filter((c) => c.agent.agentId === query.agentId);
    }
    if (query?.targetRef) {
      results = results.filter((c) => c.targetRef === query.targetRef);
    }
    return results;
  }
```

Update `claimOrRenew`, `heartbeat`, `release`, `complete`, `expireStale`, `activeClaims`, `countActiveClaims`, `detectStalled`, and `listEntities` by reading views and writing either `specs` or `statuses`; do not reintroduce a flat `claims` map.

- [ ] **Step 3: Update reconciler test mock**

In `src/core/reconciler.test.ts`, add imports:

```ts
import {
  claimToSpecRecord,
  claimToStatusRecord,
  claimViewToClaim,
  type ClaimSpecRecord,
  type ClaimStatusPatch,
} from "./models.js";
```

Inside `makeClaimStore`, add methods to the returned object:

```ts
    putClaimSpec: async (spec: ClaimSpecRecord) => {
      const existing = claimsById.get(spec.id);
      const now = new Date().toISOString();
      const view = {
        spec: {
          ...spec,
          generation: existing === undefined ? 1 : (existing.revision ?? 1) + 1,
        },
        status:
          existing === undefined
            ? {
                id: spec.id,
                phase: ClaimStatus.Active,
                observedGeneration: 0,
                lastHeartbeatAt: now,
                leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
                conditions: [],
                lastTransitionAt: now,
                attemptCount: 0,
                revision: 1,
              }
            : claimToStatusRecord(existing),
      };
      claimsById.set(spec.id, claimViewToClaim(view));
      return view;
    },
    getClaimView: async (claimId) => {
      const claim = claimsById.get(claimId);
      return claim === undefined
        ? undefined
        : { spec: claimToSpecRecord(claim), status: claimToStatusRecord(claim) };
    },
    patchClaimStatus: async (claimId, patch: ClaimStatusPatch) => {
      const claim = claimsById.get(claimId);
      if (!claim) throw new Error("missing claim");
      const updated = {
        ...claim,
        status: patch.phase ?? claim.status,
        heartbeatAt: patch.lastHeartbeatAt ?? claim.heartbeatAt,
        leaseExpiresAt: patch.leaseExpiresAt ?? claim.leaseExpiresAt,
        revision: (claim.revision ?? 1) + 1,
      };
      claimsById.set(claimId, updated);
      return { spec: claimToSpecRecord(claim), status: claimToStatusRecord(updated) };
    },
```

- [ ] **Step 4: Run tests to verify GREEN for mocks**

Run:

```bash
bun test src/core/reconciler.test.ts src/server/watch-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/test-helpers.ts src/core/reconciler.test.ts
git commit -m "test: support split claim store in mocks"
```

---

### Task 4: SQLite Migration Tests

**Files:**
- Modify: `src/local/sqlite-store.migration.test.ts`
- Modify: `src/local/sqlite-store.ts`

- [ ] **Step 1: Write failing migration tests**

In `src/local/sqlite-store.migration.test.ts`, add these tests near the other schema migration tests:

```ts
  test("fresh DB creates split claim tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-claim-split-"));
    try {
      const dbPath = join(dir, "test.db");
      const stores = createSqliteStores(dbPath);
      stores.close();

      const db = new Database(dbPath);
      const tableNames = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as readonly {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(tableNames).toContain("claim_spec");
      expect(tableNames).toContain("claim_status");
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("legacy claims rows backfill into claim_spec and claim_status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqlite-claim-split-legacy-"));
    try {
      const dbPath = join(dir, "test.db");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contributions (
          cid TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          mode TEXT NOT NULL,
          summary TEXT NOT NULL,
          description TEXT,
          agent_id TEXT NOT NULL,
          agent_name TEXT,
          created_at TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]',
          manifest_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relations (
          source_cid TEXT NOT NULL,
          target_cid TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          metadata_json TEXT
        );
        CREATE TABLE IF NOT EXISTS claims (
          claim_id TEXT PRIMARY KEY,
          target_ref TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          intent_summary TEXT NOT NULL,
          created_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL,
          context_json TEXT,
          agent_json TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 1
        );
      `);
      db.prepare(
        `INSERT INTO claims (
          claim_id, target_ref, agent_id, status, intent_summary, created_at,
          heartbeat_at, lease_expires_at, context_json, agent_json, attempt_count, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "legacy-split",
        "target-legacy",
        "agent-legacy",
        "active",
        "legacy intent",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:02:00.000Z",
        "2026-01-01T00:07:00.000Z",
        JSON.stringify({ migrated: true }),
        JSON.stringify({ agentId: "agent-legacy", platform: "codex", role: "coder" }),
        2,
        5,
      );
      db.close();

      const stores = createSqliteStores(dbPath);
      const claim = await stores.claimStore.getClaim("legacy-split");
      const view = await stores.claimStore.getClaimView("legacy-split");

      expect(claim?.claimId).toBe("legacy-split");
      expect(claim?.status).toBe("active");
      expect(claim?.attemptCount).toBe(2);
      expect(claim?.revision).toBe(5);
      expect(view?.spec.targetRef).toBe("target-legacy");
      expect(view?.spec.agent.platform).toBe("codex");
      expect(view?.spec.generation).toBe(5);
      expect(view?.status.phase).toBe("active");
      expect(view?.status.observedGeneration).toBe(5);
      expect(view?.status.lastHeartbeatAt).toBe("2026-01-01T00:02:00.000Z");

      stores.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
bun test src/local/sqlite-store.migration.test.ts
```

Expected: FAIL because split tables and `getClaimView` are not implemented.

- [ ] **Step 3: Add schema DDL and migration backfill**

In `src/local/sqlite-store.ts`, increment:

```ts
export const CURRENT_SCHEMA_VERSION = 14;
```

In `SCHEMA_DDL`, after the legacy `claims` table and indexes, add the `claim_spec` and `claim_status` tables and indexes from the design doc:

```sql
  CREATE TABLE IF NOT EXISTS claim_spec (
    id TEXT PRIMARY KEY,
    role_name TEXT,
    platform TEXT,
    blueprint TEXT,
    assignee_json TEXT,
    lease_deadline_sec INTEGER,
    priority INTEGER,
    max_iterations INTEGER,
    generation INTEGER NOT NULL DEFAULT 1,
    target_ref TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_json TEXT NOT NULL,
    intent_summary TEXT NOT NULL,
    context_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS claim_status (
    id TEXT PRIMARY KEY,
    phase TEXT NOT NULL DEFAULT 'active',
    observed_generation INTEGER NOT NULL DEFAULT 0,
    agent_session_id TEXT,
    last_heartbeat_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    current_contribution_cid TEXT,
    conditions_json TEXT NOT NULL DEFAULT '[]',
    last_transition_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (id) REFERENCES claim_spec(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_claim_spec_target ON claim_spec(target_ref);
  CREATE INDEX IF NOT EXISTS idx_claim_spec_agent ON claim_spec(agent_id);
  CREATE INDEX IF NOT EXISTS idx_claim_status_phase ON claim_status(phase);
  CREATE INDEX IF NOT EXISTS idx_claim_status_phase_lease ON claim_status(phase, lease_expires_at);
```

After the existing claim column-safe migration block, add this backfill:

```ts
    // Migration -> v14: split legacy claims into claim_spec and claim_status.
    db.run(`
      INSERT OR IGNORE INTO claim_spec (
        id, role_name, platform, assignee_json, lease_deadline_sec, generation,
        target_ref, agent_id, agent_json, intent_summary, context_json, created_at
      )
      SELECT
        claim_id,
        json_extract(agent_json, '$.role'),
        json_extract(agent_json, '$.platform'),
        agent_json,
        CASE
          WHEN strftime('%s', lease_expires_at) > strftime('%s', created_at)
          THEN CAST(strftime('%s', lease_expires_at) - strftime('%s', created_at) AS INTEGER)
          ELSE NULL
        END,
        revision,
        target_ref,
        agent_id,
        agent_json,
        intent_summary,
        context_json,
        created_at
      FROM claims
      WHERE NOT EXISTS (
        SELECT 1 FROM claim_spec WHERE claim_spec.id = claims.claim_id
      )
    `);
    db.run(`
      INSERT OR IGNORE INTO claim_status (
        id, phase, observed_generation, last_heartbeat_at, lease_expires_at,
        conditions_json, last_transition_at, attempt_count, revision
      )
      SELECT
        claim_id,
        status,
        revision,
        heartbeat_at,
        lease_expires_at,
        '[]',
        heartbeat_at,
        attempt_count,
        revision
      FROM claims
      WHERE NOT EXISTS (
        SELECT 1 FROM claim_status WHERE claim_status.id = claims.claim_id
      )
    `);
```

- [ ] **Step 4: Run migration tests**

Run:

```bash
bun test src/local/sqlite-store.migration.test.ts
```

Expected: still FAIL because `SqliteClaimStore.getClaimView` is missing. That is correct; schema migration should be in place before store implementation.

- [ ] **Step 5: Commit**

```bash
git add src/local/sqlite-store.ts src/local/sqlite-store.migration.test.ts
git commit -m "feat: add sqlite claim split schema"
```

---

### Task 5: SQLite Split Store Implementation

**Files:**
- Modify: `src/local/sqlite-store.ts`
- Test: `src/core/claim-store.conformance.ts`
- Test: `src/local/sqlite-store.test.ts`
- Test: `src/local/sqlite-store.migration.test.ts`

- [ ] **Step 1: Run conformance to verify RED**

Run:

```bash
bun test src/local/sqlite-store.test.ts
```

Expected: FAIL because `SqliteClaimStore` does not implement split methods and still reads/writes the legacy `claims` table.

- [ ] **Step 2: Add split row types and helpers**

In `src/local/sqlite-store.ts`, update imports from `../core/models.js`:

```ts
  ClaimSpecRecord,
  ClaimStatusRecord,
  ClaimView,
  claimToSpecRecord,
  claimToStatusRecord,
  claimViewToClaim,
```

Update imports from `../core/store.js`:

```ts
  ClaimStatusPatch,
```

After `interface ClaimRow`, add:

```ts
interface ClaimSpecRow {
  readonly id: string;
  readonly role_name: string | null;
  readonly platform: string | null;
  readonly blueprint: string | null;
  readonly assignee_json: string | null;
  readonly lease_deadline_sec: number | null;
  readonly priority: number | null;
  readonly max_iterations: number | null;
  readonly generation: number;
  readonly target_ref: string;
  readonly agent_id: string;
  readonly agent_json: string;
  readonly intent_summary: string;
  readonly context_json: string | null;
  readonly created_at: string;
}

interface ClaimStatusRow {
  readonly id: string;
  readonly phase: string;
  readonly observed_generation: number;
  readonly agent_session_id: string | null;
  readonly last_heartbeat_at: string;
  readonly lease_expires_at: string;
  readonly current_contribution_cid: string | null;
  readonly conditions_json: string;
  readonly last_transition_at: string;
  readonly attempt_count: number;
  readonly revision: number;
}

interface ClaimViewRow extends ClaimSpecRow, ClaimStatusRow {}
```

Add row converters:

```ts
function rowToClaimSpec(row: ClaimSpecRow): ClaimSpecRecord {
  return {
    id: row.id,
    roleName: row.role_name ?? undefined,
    platform: row.platform ?? undefined,
    blueprint: row.blueprint ?? undefined,
    assignee:
      row.assignee_json !== null
        ? (JSON.parse(row.assignee_json) as AgentIdentity)
        : undefined,
    leaseDeadlineSec: row.lease_deadline_sec ?? undefined,
    priority: row.priority ?? undefined,
    maxIterations: row.max_iterations ?? undefined,
    generation: row.generation,
    targetRef: row.target_ref,
    agent: JSON.parse(row.agent_json) as AgentIdentity,
    intentSummary: row.intent_summary,
    context:
      row.context_json !== null
        ? (JSON.parse(row.context_json) as Readonly<Record<string, JsonValue>>)
        : undefined,
    createdAt: row.created_at,
  };
}

function rowToClaimStatus(row: ClaimStatusRow): ClaimStatusRecord {
  return {
    id: row.id,
    phase: row.phase as ClaimStatus,
    observedGeneration: row.observed_generation,
    agentSessionId: row.agent_session_id ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    currentContributionCid: row.current_contribution_cid ?? undefined,
    conditions: JSON.parse(row.conditions_json) as readonly import("../core/entity.js").Condition[],
    lastTransitionAt: row.last_transition_at,
    attemptCount: row.attempt_count,
    revision: row.revision,
  };
}

function rowToClaimView(row: ClaimViewRow): ClaimView {
  return {
    spec: rowToClaimSpec(row),
    status: rowToClaimStatus(row),
  };
}
```

- [ ] **Step 3: Replace claim select constants with joined split select**

Keep `ClaimRow` for migration helper compatibility. Add:

```ts
const CLAIM_VIEW_SELECT_COLS = `
  s.id AS id,
  s.role_name AS role_name,
  s.platform AS platform,
  s.blueprint AS blueprint,
  s.assignee_json AS assignee_json,
  s.lease_deadline_sec AS lease_deadline_sec,
  s.priority AS priority,
  s.max_iterations AS max_iterations,
  s.generation AS generation,
  s.target_ref AS target_ref,
  s.agent_id AS agent_id,
  s.agent_json AS agent_json,
  s.intent_summary AS intent_summary,
  s.context_json AS context_json,
  s.created_at AS created_at,
  st.phase AS phase,
  st.observed_generation AS observed_generation,
  st.agent_session_id AS agent_session_id,
  st.last_heartbeat_at AS last_heartbeat_at,
  st.lease_expires_at AS lease_expires_at,
  st.current_contribution_cid AS current_contribution_cid,
  st.conditions_json AS conditions_json,
  st.last_transition_at AS last_transition_at,
  st.attempt_count AS attempt_count,
  st.revision AS revision
`;
```

In the constructor, replace `stmtGetClaim` with:

```ts
    this.stmtGetClaim = db.query(
      `SELECT ${CLAIM_VIEW_SELECT_COLS}
       FROM claim_spec s
       JOIN claim_status st ON st.id = s.id
       WHERE s.id = ?`,
    );
```

- [ ] **Step 4: Add split write helpers**

Inside `SqliteClaimStore`, add:

```ts
  private insertSpecAndDefaultStatus(claim: Claim): void {
    const spec = claimToSpecRecord(claim);
    const status = claimToStatusRecord({ ...claim, revision: 1 });
    this.insertSpecRow({ ...spec, generation: 1 });
    this.insertStatusRow(status);
  }

  private insertSpecRow(spec: ClaimSpecRecord): void {
    this.db
      .prepare(
        `INSERT INTO claim_spec (
          id, role_name, platform, blueprint, assignee_json, lease_deadline_sec,
          priority, max_iterations, generation, target_ref, agent_id, agent_json,
          intent_summary, context_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        spec.id,
        spec.roleName ?? null,
        spec.platform ?? null,
        spec.blueprint ?? null,
        spec.assignee !== undefined ? JSON.stringify(spec.assignee) : null,
        spec.leaseDeadlineSec ?? null,
        spec.priority ?? null,
        spec.maxIterations ?? null,
        spec.generation,
        spec.targetRef,
        spec.agent.agentId,
        JSON.stringify(spec.agent),
        spec.intentSummary,
        spec.context !== undefined ? JSON.stringify(spec.context) : null,
        toUtcIso(spec.createdAt),
      );
  }

  private insertStatusRow(status: ClaimStatusRecord): void {
    this.db
      .prepare(
        `INSERT INTO claim_status (
          id, phase, observed_generation, agent_session_id, last_heartbeat_at,
          lease_expires_at, current_contribution_cid, conditions_json,
          last_transition_at, attempt_count, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        status.id,
        status.phase,
        status.observedGeneration,
        status.agentSessionId ?? null,
        toUtcIso(status.lastHeartbeatAt),
        toUtcIso(status.leaseExpiresAt),
        status.currentContributionCid ?? null,
        JSON.stringify(status.conditions),
        toUtcIso(status.lastTransitionAt),
        status.attemptCount,
        status.revision,
      );
  }
```

- [ ] **Step 5: Implement split methods**

Add methods to `SqliteClaimStore` before `createClaim`:

```ts
  putClaimSpec = async (spec: ClaimSpecRecord): Promise<ClaimView> => {
    if (spec.context !== undefined) {
      const result = ContextSchema.safeParse(spec.context);
      if (!result.success) {
        throw new Error(`Invalid claim context: ${result.error.message}`);
      }
    }
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const existing = this.readClaimView(spec.id);
      if (existing === null) {
        const createdSpec: ClaimSpecRecord = { ...spec, generation: 1 };
        this.insertSpecRow(createdSpec);
        const leaseMs = (spec.leaseDeadlineSec ?? DEFAULT_LEASE_DURATION_MS / 1000) * 1000;
        this.insertStatusRow({
          id: spec.id,
          phase: "active" as ClaimStatus,
          observedGeneration: 0,
          lastHeartbeatAt: now,
          leaseExpiresAt: new Date(Date.parse(spec.createdAt) + leaseMs).toISOString(),
          conditions: [],
          lastTransitionAt: now,
          attemptCount: 0,
          revision: 1,
        });
        return;
      }
      this.db
        .prepare(
          `UPDATE claim_spec
           SET role_name = ?, platform = ?, blueprint = ?, assignee_json = ?,
               lease_deadline_sec = ?, priority = ?, max_iterations = ?,
               generation = generation + 1, target_ref = ?, agent_id = ?,
               agent_json = ?, intent_summary = ?, context_json = ?
           WHERE id = ?`,
        )
        .run(
          spec.roleName ?? null,
          spec.platform ?? null,
          spec.blueprint ?? null,
          spec.assignee !== undefined ? JSON.stringify(spec.assignee) : null,
          spec.leaseDeadlineSec ?? null,
          spec.priority ?? null,
          spec.maxIterations ?? null,
          spec.targetRef,
          spec.agent.agentId,
          JSON.stringify(spec.agent),
          spec.intentSummary,
          spec.context !== undefined ? JSON.stringify(spec.context) : null,
          spec.id,
        );
    });
    tx.immediate();
    const view = this.readClaimView(spec.id);
    if (view === null) throw new Error(`Failed to read back claim view '${spec.id}'`);
    this.onClaimWrite?.(view.status.revision === 1 ? "ADDED" : "MODIFIED", claimViewToClaim(view));
    return view;
  };

  getClaimView = async (claimId: string): Promise<ClaimView | undefined> => {
    return this.readClaimView(claimId) ?? undefined;
  };

  patchClaimStatus = async (claimId: string, patch: ClaimStatusPatch): Promise<ClaimView> => {
    const existing = this.readClaimView(claimId);
    if (existing === null) {
      throw new NotFoundError({
        resource: "Claim",
        identifier: claimId,
        message: `Claim '${claimId}' not found`,
      });
    }
    const next = {
      phase: patch.phase ?? existing.status.phase,
      observedGeneration: patch.observedGeneration ?? existing.status.observedGeneration,
      agentSessionId: patch.agentSessionId ?? existing.status.agentSessionId,
      lastHeartbeatAt: patch.lastHeartbeatAt ?? existing.status.lastHeartbeatAt,
      leaseExpiresAt: patch.leaseExpiresAt ?? existing.status.leaseExpiresAt,
      currentContributionCid:
        patch.currentContributionCid ?? existing.status.currentContributionCid,
      conditions: patch.conditions ?? existing.status.conditions,
      lastTransitionAt: patch.lastTransitionAt ?? existing.status.lastTransitionAt,
    };
    this.db
      .prepare(
        `UPDATE claim_status
         SET phase = ?, observed_generation = ?, agent_session_id = ?,
             last_heartbeat_at = ?, lease_expires_at = ?, current_contribution_cid = ?,
             conditions_json = ?, last_transition_at = ?, revision = revision + 1
         WHERE id = ?`,
      )
      .run(
        next.phase,
        next.observedGeneration,
        next.agentSessionId ?? null,
        toUtcIso(next.lastHeartbeatAt),
        toUtcIso(next.leaseExpiresAt),
        next.currentContributionCid ?? null,
        JSON.stringify(next.conditions),
        toUtcIso(next.lastTransitionAt),
        claimId,
      );
    const view = this.readClaimView(claimId);
    if (view === null) throw new Error(`Failed to read back claim view '${claimId}'`);
    this.onClaimWrite?.("MODIFIED", claimViewToClaim(view));
    return view;
  };
```

Add private read helper:

```ts
  private readClaimView(claimId: string): ClaimView | null {
    const row = this.stmtGetClaim.get(claimId) as ClaimViewRow | null;
    if (row === null) return null;
    return rowToClaimView(row);
  }
```

- [ ] **Step 6: Rewrite legacy methods to use split tables**

Make these replacements:

```ts
  getClaim = async (claimId: string): Promise<Claim | undefined> => {
    const view = this.readClaimView(claimId);
    return view === null ? undefined : claimViewToClaim(view);
  };
```

In `createClaim`, replace `this.insertClaimRow(...)` with:

```ts
      this.insertSpecAndDefaultStatus({
        ...claim,
        createdAt: createdAtUtc,
        heartbeatAt: heartbeatUtc,
        leaseExpiresAt: leaseExpiresUtc,
        revision: 1,
      });
```

In `claimOrRenew`, update the active query to join split tables:

```sql
SELECT s.id AS claim_id, s.agent_id AS agent_id
FROM claim_spec s
JOIN claim_status st ON st.id = s.id
WHERE s.target_ref = ? AND st.phase = 'active' AND st.lease_expires_at >= ?
```

For renewal, update only `claim_status.last_heartbeat_at`, `claim_status.lease_expires_at`, `claim_status.revision`, and the compatibility `claim_spec.intent_summary`:

```sql
UPDATE claim_status
SET last_heartbeat_at = ?, lease_expires_at = ?, revision = revision + 1
WHERE id = ?
```

```sql
UPDATE claim_spec
SET intent_summary = ?
WHERE id = ?
```

Replace all remaining `claims` queries in `heartbeat`, `transitionClaim`, `expireStale`, `activeClaims`, `listClaims`, `cleanCompleted`, `countActiveClaims`, and `detectStalled` with joined split queries using `CLAIM_VIEW_SELECT_COLS`. Status mutations update only `claim_status`.

- [ ] **Step 7: Run SQLite tests to verify GREEN**

Run:

```bash
bun test src/local/sqlite-store.test.ts src/local/sqlite-store.migration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/local/sqlite-store.ts src/local/sqlite-store.test.ts src/local/sqlite-store.migration.test.ts
git commit -m "feat: store claims as sqlite spec status records"
```

---

### Task 6: Nexus Logical Split Methods

**Files:**
- Modify: `src/nexus/nexus-claim-store.ts`
- Modify: `tests/nexus/unit/nexus-claim-store.test.ts`
- Test: `tests/nexus/unit/nexus-claim-store.test.ts`

- [ ] **Step 1: Run Nexus tests to verify RED**

Run:

```bash
bun test tests/nexus/unit/nexus-claim-store.test.ts
```

Expected: FAIL because `NexusClaimStore` does not implement split methods.

- [ ] **Step 2: Add imports**

In `src/nexus/nexus-claim-store.ts`, update imports from `../core/models.js`:

```ts
import {
  claimToSpecRecord,
  claimToStatusRecord,
  claimViewToClaim,
  type Claim,
  type ClaimSpecRecord,
  type ClaimStatus,
  type ClaimStatusRecord,
  type ClaimView,
} from "../core/models.js";
```

Update store imports:

```ts
  ClaimStatusPatch,
```

- [ ] **Step 3: Add Nexus claim document helpers**

Replace the current flat claim JSON encoding with a version-tolerant document. Keep the same `claimPath()` so existing files remain readable.

Add near the encoder/decoder helpers:

```ts
interface ClaimDocument {
  readonly spec: ClaimSpecRecord;
  readonly status: ClaimStatusRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isClaimDocument(value: unknown): value is ClaimDocument {
  return (
    isRecord(value) &&
    isRecord(value.spec) &&
    isRecord(value.status) &&
    typeof value.spec.id === "string" &&
    typeof value.status.id === "string"
  );
}

function claimToDocument(claim: Claim): ClaimDocument {
  return {
    spec: claimToSpecRecord(claim),
    status: claimToStatusRecord(claim),
  };
}

function decodeClaimDocument(data: Uint8Array): ClaimDocument {
  const parsed = JSON.parse(decoder.decode(data)) as unknown;
  if (isClaimDocument(parsed)) return parsed;
  return claimToDocument(parsed as Claim);
}

function encodeClaimDocument(document: ClaimDocument): Uint8Array {
  return encoder.encode(JSON.stringify(document));
}
```

Replace `ClaimWithEtag` with:

```ts
interface ClaimDocumentWithEtag {
  readonly document: ClaimDocument;
  readonly etag: string;
}
```

Update the private read/write helpers so `readClaim(claimId)` returns `claimViewToClaim(document)`, `readClaimWithEtag(claimId)` returns `ClaimDocumentWithEtag`, and `writeClaim`, `writeClaimCas`, and `writeClaimConditional` convert flat claims through `claimToDocument(claim)` before writing. This preserves legacy callers while letting split methods keep independent `spec.generation` and `status.revision` in the stored JSON.

- [ ] **Step 4: Implement split methods over claim documents**

Add these public methods before `createClaim`:

```ts
  async putClaimSpec(spec: ClaimSpecRecord): Promise<ClaimView> {
    const existing = await this.readClaimWithEtag(spec.id);
    const now = new Date().toISOString();
    if (existing === undefined) {
      const leaseMs = (spec.leaseDeadlineSec ?? DEFAULT_LEASE_DURATION_MS / 1000) * 1000;
      const document: ClaimDocument = {
        spec: { ...spec, generation: 1, createdAt: toUtcIso(spec.createdAt) },
        status: {
          id: spec.id,
          phase: "active" as ClaimStatus,
          observedGeneration: 0,
          lastHeartbeatAt: now,
          leaseExpiresAt: new Date(Date.parse(spec.createdAt) + leaseMs).toISOString(),
          conditions: [],
          lastTransitionAt: now,
          attemptCount: 0,
          revision: 1,
        },
      };
      await this.writeClaimDocumentConditional(spec.id, document, { ifNoneMatch: "*" });
      const claim = claimViewToClaim(document);
      await this.writeActiveIndexExclusive(claim);
      this.claimCache.set(spec.id, claim);
      this.invalidateActiveClaimsCache();
      this.publishWatch(claim, "ADDED");
      return document;
    }

    const document: ClaimDocument = {
      spec: {
        ...spec,
        generation: existing.document.spec.generation + 1,
        createdAt: existing.document.spec.createdAt,
      },
      status: existing.document.status,
    };
    await this.writeClaimDocumentCas(spec.id, document, existing.etag);
    const claim = claimViewToClaim(document);
    this.claimCache.set(claim.claimId, claim);
    this.invalidateActiveClaimsCache();
    this.publishWatch(claim, "MODIFIED");
    return document;
  }

  async getClaimView(claimId: string): Promise<ClaimView | undefined> {
    const result = await this.readClaimWithEtag(claimId);
    return result?.document;
  }

  async patchClaimStatus(claimId: string, patch: ClaimStatusPatch): Promise<ClaimView> {
    const result = await this.readClaimWithEtag(claimId);
    if (result === undefined) {
      throw new NotFoundError({
        resource: "Claim",
        identifier: claimId,
        message: `Claim '${claimId}' not found`,
      });
    }
    const document: ClaimDocument = {
      spec: result.document.spec,
      status: {
        ...result.document.status,
        phase: patch.phase ?? result.document.status.phase,
        observedGeneration: patch.observedGeneration ?? result.document.status.observedGeneration,
        agentSessionId: patch.agentSessionId ?? result.document.status.agentSessionId,
        lastHeartbeatAt: patch.lastHeartbeatAt ?? result.document.status.lastHeartbeatAt,
        leaseExpiresAt: patch.leaseExpiresAt ?? result.document.status.leaseExpiresAt,
        currentContributionCid:
          patch.currentContributionCid ?? result.document.status.currentContributionCid,
        conditions: patch.conditions ?? result.document.status.conditions,
        lastTransitionAt: patch.lastTransitionAt ?? result.document.status.lastTransitionAt,
        revision: result.document.status.revision + 1,
      },
    };
    await this.writeClaimDocumentCas(claimId, document, result.etag);
    const claim = claimViewToClaim(document);
    this.claimCache.set(claim.claimId, claim);
    this.invalidateActiveClaimsCache();
    this.publishWatch(claim, "MODIFIED");
    return document;
  }
```

Import `NotFoundError` from `../core/errors.js` alongside the existing error imports.

- [ ] **Step 5: Add document write helpers**

Add these private write helpers near existing claim write helpers:

```ts
  private async writeClaimDocumentConditional(
    claimId: string,
    document: ClaimDocument,
    opts: { readonly ifNoneMatch: "*" },
  ): Promise<void> {
    await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.write(claimPath(this.zoneId, claimId), encodeClaimDocument(document), opts),
        ),
      "writeClaimDocumentConditional",
      this.config,
    );
  }

  private async writeClaimDocumentCas(
    claimId: string,
    document: ClaimDocument,
    etag: string,
  ): Promise<void> {
    await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.write(claimPath(this.zoneId, claimId), encodeClaimDocument(document), {
            ifMatch: etag,
          }),
        ),
      "writeClaimDocumentCas",
      this.config,
    );
  }
```

- [ ] **Step 6: Add Nexus adapter-specific status test**

In `tests/nexus/unit/nexus-claim-store.test.ts`, add:

```ts
  test("patchClaimStatus preserves spec fields in Nexus compatibility storage", async () => {
    const created = await store.putClaimSpec({
      id: "nexus-split",
      roleName: "coder",
      platform: "codex",
      targetRef: "target-nexus-split",
      agent: { agentId: "agent-nexus", role: "coder", platform: "codex" },
      intentSummary: "nexus split",
      createdAt: "2026-01-01T00:00:00.000Z",
      generation: 1,
    });

    const patched = await store.patchClaimStatus("nexus-split", {
      phase: "completed",
      observedGeneration: created.spec.generation,
      lastHeartbeatAt: "2026-01-01T00:05:00.000Z",
    });

    expect(patched.spec.intentSummary).toBe("nexus split");
    expect(patched.spec.generation).toBe(created.spec.generation);
    expect(patched.status.phase).toBe("completed");
    expect(patched.status.revision).toBe(created.status.revision + 1);
  });
```

- [ ] **Step 7: Run Nexus tests to verify GREEN**

Run:

```bash
bun test tests/nexus/unit/nexus-claim-store.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/nexus/nexus-claim-store.ts tests/nexus/unit/nexus-claim-store.test.ts
git commit -m "feat: add nexus claim spec status methods"
```

---

### Task 7: HTTP Split Routes and Controller Auth

**Files:**
- Modify: `src/server/deps.ts`
- Modify: `src/server/serve.ts`
- Modify: `src/server/routes/claims.ts`
- Modify: `tests/server/helpers.ts`
- Modify: `tests/server/claims.test.ts`

- [ ] **Step 1: Write failing HTTP tests**

In `tests/server/helpers.ts`, add:

```ts
export const TEST_CONTROLLER_TOKEN = "controller-token-test";
export const TEST_CONTROLLER_HEADERS = {
  "X-Grove-Controller-Token": TEST_CONTROLLER_TOKEN,
} as const;
```

Add `controllerToken: TEST_CONTROLLER_TOKEN` to `deps`.

In `tests/server/claims.test.ts`, update imports:

```ts
import {
  claimBody,
  createTestContext,
  TEST_AUTH_HEADERS,
  TEST_CONTROLLER_HEADERS,
} from "./helpers.js";
```

Add these tests after the `POST /api/claims` block and before legacy `PATCH /api/claims/:id`:

```ts
describe("split claim routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  test("PUT /api/claims/:id writes spec only and returns merged view", async () => {
    const res = await ctx.app.request("/api/claims/spec-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({
        roleName: "coder",
        platform: "codex",
        targetRef: "target-spec-route",
        agent: { agentId: "agent-spec-route", role: "coder", platform: "codex" },
        intentSummary: "write spec route",
        leaseDeadlineSec: 600,
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.spec.id).toBe("spec-route");
    expect(data.spec.roleName).toBe("coder");
    expect(data.status.phase).toBe("active");
    expect(data.status.observedGeneration).toBe(0);
  });

  test("PUT /api/claims/:id rejects status-owned fields", async () => {
    const res = await ctx.app.request("/api/claims/spec-reject", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({
        targetRef: "target-spec-reject",
        agent: { agentId: "agent-spec-reject" },
        intentSummary: "bad spec",
        phase: "completed",
      }),
    });

    expect(res.status).toBe(400);
  });

  test("GET /api/claims/:id returns merged view", async () => {
    await ctx.app.request("/api/claims/get-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({
        targetRef: "target-get-route",
        agent: { agentId: "agent-get-route" },
        intentSummary: "read merged",
      }),
    });

    const res = await ctx.app.request("/api/claims/get-route", { headers: TEST_AUTH_HEADERS });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.spec.id).toBe("get-route");
    expect(data.status.id).toBe("get-route");
  });

  test("PATCH /api/claims/:id/status requires controller token", async () => {
    await ctx.app.request("/api/claims/status-auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({
        targetRef: "target-status-auth",
        agent: { agentId: "agent-status-auth" },
        intentSummary: "status auth",
      }),
    });

    const res = await ctx.app.request("/api/claims/status-auth/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({ phase: "completed" }),
    });

    expect(res.status).toBe(403);
  });

  test("PATCH /api/claims/:id/status writes status only with controller token", async () => {
    const create = await ctx.app.request("/api/claims/status-route", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({
        targetRef: "target-status-route",
        agent: { agentId: "agent-status-route" },
        intentSummary: "status route",
      }),
    });
    const created = await create.json();

    const res = await ctx.app.request("/api/claims/status-route/status", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
      },
      body: JSON.stringify({
        phase: "completed",
        observedGeneration: created.spec.generation,
        lastHeartbeatAt: "2026-01-01T00:05:00.000Z",
        conditions: [
          {
            type: "Completed",
            status: "True",
            observedGeneration: created.spec.generation,
            lastTransitionTime: "2026-01-01T00:05:00.000Z",
            reason: "controller",
            message: "done",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.spec.intentSummary).toBe("status route");
    expect(data.spec.generation).toBe(created.spec.generation);
    expect(data.status.phase).toBe("completed");
    expect(data.status.observedGeneration).toBe(created.spec.generation);
    expect(data.status.conditions[0].type).toBe("Completed");
  });

  test("PATCH /api/claims/:id/status rejects spec-owned fields", async () => {
    await ctx.app.request("/api/claims/status-reject", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
      body: JSON.stringify({
        targetRef: "target-status-reject",
        agent: { agentId: "agent-status-reject" },
        intentSummary: "status reject",
      }),
    });

    const res = await ctx.app.request("/api/claims/status-reject/status", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...TEST_AUTH_HEADERS,
        ...TEST_CONTROLLER_HEADERS,
      },
      body: JSON.stringify({ intentSummary: "bad status" }),
    });

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run HTTP tests to verify RED**

Run:

```bash
bun test tests/server/claims.test.ts
```

Expected: FAIL because routes and controller token are not implemented.

- [ ] **Step 3: Add controller token dependency**

In `src/server/deps.ts`, add to `ServerDeps`:

```ts
  /** Optional controller token required by controller-owned status subresource writes. */
  readonly controllerToken?: string | undefined;
```

In `src/server/serve.ts`, when building `deps`, set:

```ts
  controllerToken: process.env.GROVE_CONTROLLER_TOKEN,
```

- [ ] **Step 4: Add route schemas and auth helper**

In `src/server/routes/claims.ts`, add:

```ts
const statusOwnedFields = new Set([
  "status",
  "phase",
  "observedGeneration",
  "agentSessionId",
  "lastHeartbeatAt",
  "heartbeatAt",
  "leaseExpiresAt",
  "currentContributionCid",
  "conditions",
  "lastTransitionAt",
  "revision",
]);

const specOwnedFields = new Set([
  "roleName",
  "platform",
  "blueprint",
  "assignee",
  "leaseDeadlineSec",
  "priority",
  "maxIterations",
  "targetRef",
  "agent",
  "intentSummary",
  "context",
  "generation",
  "revision",
]);

function rejectFields(
  body: Record<string, unknown>,
  forbidden: ReadonlySet<string>,
  ctx: z.RefinementCtx,
): void {
  for (const key of Object.keys(body)) {
    if (forbidden.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `Field '${key}' belongs to the other claim subresource`,
      });
    }
  }
}
```

Add schemas:

```ts
const specBodySchema = z
  .object({
    roleName: z.string().min(1).optional(),
    platform: z.string().min(1).optional(),
    blueprint: z.string().min(1).optional(),
    assignee: createBodySchema.shape.agent.optional(),
    leaseDeadlineSec: z.number().int().positive().optional(),
    priority: z.number().int().optional(),
    maxIterations: z.number().int().positive().optional(),
    targetRef: z.string().min(1),
    agent: createBodySchema.shape.agent,
    intentSummary: z.string().min(1),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => rejectFields(body, statusOwnedFields, ctx));

const statusBodySchema = z
  .object({
    phase: z.enum(["active", "released", "expired", "completed"]).optional(),
    observedGeneration: z.number().int().min(0).optional(),
    agentSessionId: z.string().min(1).optional(),
    lastHeartbeatAt: z.string().datetime().optional(),
    leaseExpiresAt: z.string().datetime().optional(),
    currentContributionCid: z.string().min(1).optional(),
    conditions: z
      .array(
        z.object({
          type: z.string(),
          status: z.enum(["True", "False", "Unknown"]),
          observedGeneration: z.number().int().min(0),
          lastTransitionTime: z.string(),
          reason: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
    lastTransitionAt: z.string().datetime().optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => rejectFields(body, specOwnedFields, ctx));
```

- [ ] **Step 5: Add routes before legacy `PATCH /:id`**

In `src/server/routes/claims.ts`, after `claims.post("/", ...)`, add:

```ts
claims.put("/:id", zValidator("json", specBodySchema), async (c) => {
  const claimId = c.req.param("id");
  const body = c.req.valid("json");
  const existing = await c.get("deps").claimStore.getClaimView(claimId);
  const now = new Date().toISOString();
  const view = await c.get("deps").claimStore.putClaimSpec({
    id: claimId,
    roleName: body.roleName,
    platform: body.platform,
    blueprint: body.blueprint,
    assignee: body.assignee as AgentIdentity | undefined,
    leaseDeadlineSec: body.leaseDeadlineSec,
    priority: body.priority,
    maxIterations: body.maxIterations,
    generation: 0,
    targetRef: body.targetRef,
    agent: body.agent as AgentIdentity,
    intentSummary: body.intentSummary,
    ...(body.context !== undefined
      ? { context: body.context as Readonly<Record<string, JsonValue>> }
      : {}),
    createdAt: existing?.spec.createdAt ?? now,
  });
  return c.json(view, existing === undefined ? 201 : 200);
});

claims.get("/:id", async (c) => {
  const claimId = c.req.param("id");
  const view = await c.get("deps").claimStore.getClaimView(claimId);
  if (view === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: `Claim '${claimId}' not found` } }, 404);
  }
  return c.json(view);
});

claims.patch("/:id/status", zValidator("json", statusBodySchema), async (c) => {
  const deps = c.get("deps");
  if (
    deps.controllerToken === undefined ||
    c.req.header("X-Grove-Controller-Token") !== deps.controllerToken
  ) {
    return c.json({ error: { code: "FORBIDDEN", message: "Controller token required" } }, 403);
  }
  const claimId = c.req.param("id");
  const body = c.req.valid("json");
  const view = await deps.claimStore.patchClaimStatus(claimId, {
    phase: body.phase,
    observedGeneration: body.observedGeneration,
    agentSessionId: body.agentSessionId,
    lastHeartbeatAt: body.lastHeartbeatAt,
    leaseExpiresAt: body.leaseExpiresAt,
    currentContributionCid: body.currentContributionCid,
    conditions: body.conditions,
    lastTransitionAt: body.lastTransitionAt,
  });
  return c.json(view);
});
```

- [ ] **Step 6: Run HTTP tests to verify GREEN**

Run:

```bash
bun test tests/server/claims.test.ts
```

Expected: PASS, including existing legacy route tests.

- [ ] **Step 7: Commit**

```bash
git add src/server/deps.ts src/server/serve.ts src/server/routes/claims.ts tests/server/helpers.ts tests/server/claims.test.ts
git commit -m "feat: add claim spec status routes"
```

---

### Task 8: Watch, Entity, and Legacy Compatibility Verification

**Files:**
- Modify: `src/local/sqlite-store.test.ts`
- Modify: `src/core/operations/claim.test.ts`
- Test: `src/local/sqlite-store.test.ts`
- Test: `src/core/operations/claim.test.ts`

- [ ] **Step 1: Add SQLite watch/status ownership test**

In `src/local/sqlite-store.test.ts`, add in the claim watch describe block:

```ts
  test("spec writes and status writes emit claim watch snapshots without cross-owned field drift", async () => {
    const events: Array<{ op: string; claim: import("../core/models.js").Claim }> = [];
    claimStore.onClaimWrite = (op, c) => events.push({ op, claim: c });

    const created = await claimStore.putClaimSpec({
      id: "watch-split",
      targetRef: "target-watch-split",
      agent: { agentId: "agent-watch-split" },
      intentSummary: "initial split spec",
      createdAt: "2026-01-01T00:00:00.000Z",
      generation: 1,
    });
    const patched = await claimStore.patchClaimStatus("watch-split", {
      phase: "completed",
      observedGeneration: created.spec.generation,
      lastHeartbeatAt: "2026-01-01T00:05:00.000Z",
    });

    expect(events.map((e) => e.op)).toEqual(["ADDED", "MODIFIED"]);
    expect(events[0]?.claim.intentSummary).toBe("initial split spec");
    expect(events[1]?.claim.intentSummary).toBe("initial split spec");
    expect(events[1]?.claim.status).toBe("completed");
    expect(patched.spec.intentSummary).toBe("initial split spec");
  });
```

- [ ] **Step 2: Run test to verify RED or GREEN**

Run:

```bash
bun test src/local/sqlite-store.test.ts
```

Expected: PASS. The watch callbacks should emit `claimViewToClaim(view)` snapshots.

- [ ] **Step 3: Add operation compatibility test**

In `src/core/operations/claim.test.ts`, add a test near existing claim operation tests:

```ts
  test("claimOperation remains compatible with split claim store methods", async () => {
    const result = await claimOperation(
      {
        targetRef: "target-operation-split",
        agent: { agentId: "agent-operation-split", role: "coder", platform: "codex" },
        intentSummary: "operation split",
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("claim operation failed");
    const claimId = result.value.claimId;
    const view = await deps.claimStore?.getClaimView(claimId);
    expect(view?.spec.targetRef).toBe("target-operation-split");
    expect(view?.spec.roleName).toBe("coder");
    expect(view?.status.phase).toBe("active");
  });
```

Use the existing `deps` variable from the `beforeEach` in `describe("claimOperation", ...)`.

- [ ] **Step 4: Run operation tests**

Run:

```bash
bun test src/core/operations/claim.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/local/sqlite-store.test.ts src/core/operations/claim.test.ts
git commit -m "test: verify claim split compatibility"
```

---

### Task 9: Full Verification and Cleanup

**Files:**
- Modify only files needed for compile, lint, or test failures discovered in this task.

- [ ] **Step 1: Run focused test suite**

Run:

```bash
bun test tests/server/claims.test.ts src/local/sqlite-store.test.ts src/local/sqlite-store.migration.test.ts src/core/entity.test.ts src/core/operations/claim.test.ts tests/nexus/unit/nexus-claim-store.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run Biome**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --stat HEAD
git diff --check
```

Expected: `git diff --check` prints nothing. Diff stat includes only claim split implementation, tests, and docs.

- [ ] **Step 5: Commit final fixes if any**

If Step 1, 2, or 3 required changes, commit them:

```bash
git add src tests docs
git commit -m "chore: stabilize claim spec status split"
```

If no changes were needed, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage:
  - Split DTOs and `ClaimStore` methods: Tasks 1 and 2.
  - SQLite physical tables and migration: Tasks 4 and 5.
  - In-memory and Nexus logical adapters: Tasks 3 and 6.
  - New HTTP routes and controller token: Task 7.
  - Legacy flat route/store compatibility: Tasks 5, 7, and 8.
  - Watch/entity behavior: Tasks 2 and 8.
- Type consistency:
  - `ClaimSpecRecord`, `ClaimStatusRecord`, `ClaimStatusPatch`, and `ClaimView` are the names used consistently across tasks.
  - HTTP status body uses `phase`, not legacy `status`.
  - Store status patch uses `lastHeartbeatAt`, while flat `Claim` keeps `heartbeatAt`.
- Verification:
  - Every implementation task has a failing test command before code changes.
  - Final verification uses `bun test`, `bun run typecheck`, and `bun run check`.
