# Owner Finalizers Cascade Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #271 end to end: owner references, session and claim finalizers, deterministic session hard-delete cleanup, force-delete warning/audit behavior, and operator inspection across SQLite, Nexus, HTTP, MCP, and CLI.

**Architecture:** Add small core lifecycle metadata types, then push ownership through existing store and operation boundaries. Session stores own deletion orchestration; claim stores expose owner-aware cleanup helpers; HTTP, MCP, and CLI become thin callers of the same store contract.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, `bun:test`, Hono, MCP SDK, SQLite through `bun:sqlite`, existing Nexus VFS client.

**Spec:** `docs/superpowers/specs/2026-05-07-owner-finalizers-cascade-cleanup-design.md`

**Issue:** [#271](https://github.com/windoliver/grove/issues/271)

---

## Scope Check

Full issue scope spans core models, storage backends, operation ownership stamping, and user-facing delete surfaces. It is still one cohesive subsystem: deterministic session deletion. Keep the implementation in one PR, but commit after each task so review can isolate failures.

## File Map

**Create:**
- `src/core/lifecycle-metadata.ts`
- `src/core/lifecycle-metadata.test.ts`
- `src/server/routes/sessions.test.ts`

**Modify:**
- `src/core/models.ts`
- `src/core/session.ts`
- `src/core/store.ts`
- `src/core/entity.ts`
- `src/core/entity.test.ts`
- `src/core/test-helpers.ts`
- `src/core/session-store.conformance.ts`
- `src/core/claim-store.conformance.ts`
- `src/core/in-memory-session-store.ts`
- `src/core/in-memory-session-store.test.ts`
- `src/core/operations/deps.ts`
- `src/core/operations/claim.ts`
- `src/core/operations/claim.test.ts`
- `src/mcp/operation-adapter.ts`
- `src/mcp/serve.ts`
- `src/mcp/serve-http.ts`
- `src/mcp/tools/session.ts`
- `src/mcp/tools/session.test.ts`
- `src/server/deps.ts`
- `src/server/test-helpers.ts`
- `src/server/routes/sessions.ts`
- `src/local/sqlite-store.ts`
- `src/local/sqlite-store.test.ts`
- `src/local/sqlite-goal-session-store.ts`
- `src/local/sqlite-goal-session-store.test.ts`
- `src/nexus/nexus-claim-store.ts`
- `src/nexus/nexus-claim-store.test.ts`
- `src/nexus/nexus-session-store.ts`
- `src/nexus/nexus-session-store.test.ts`
- `src/cli/commands/session.ts`
- `src/cli/main.integration.test.ts`

## Task 1: Core Lifecycle Metadata and Entity Projection

**Files:**
- Create: `src/core/lifecycle-metadata.ts`
- Create: `src/core/lifecycle-metadata.test.ts`
- Modify: `src/core/models.ts`
- Modify: `src/core/session.ts`
- Modify: `src/core/entity.ts`
- Modify: `src/core/entity.test.ts`
- Modify: `src/core/test-helpers.ts`

- [ ] **Step 1: Write failing lifecycle metadata tests**

Add `src/core/lifecycle-metadata.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SESSION_FINALIZERS,
  Finalizer,
  appendDeletionAudit,
  ownerRefsEqual,
} from "./lifecycle-metadata.js";

describe("lifecycle metadata", () => {
  test("DEFAULT_SESSION_FINALIZERS uses the stable cleanup order", () => {
    expect(DEFAULT_SESSION_FINALIZERS).toEqual([
      Finalizer.ReleaseSlots,
      Finalizer.DrainContribs,
      Finalizer.CloseRuntime,
    ]);
  });

  test("ownerRefsEqual compares kind, id, and uid", () => {
    const a = { kind: "session" as const, id: "s1", uid: "uid-1" };
    expect(ownerRefsEqual(a, { kind: "session", id: "s1", uid: "uid-1" })).toBe(true);
    expect(ownerRefsEqual(a, { kind: "session", id: "s1", uid: "uid-2" })).toBe(false);
    expect(ownerRefsEqual(a, undefined)).toBe(false);
  });

  test("appendDeletionAudit appends a force-delete warning event", () => {
    const event = appendDeletionAudit(undefined, {
      at: "2026-05-07T00:00:00.000Z",
      actor: "cli",
      warning: "force delete skipped finalizer waits for session s1",
    });

    expect(event).toEqual([
      {
        at: "2026-05-07T00:00:00.000Z",
        actor: "cli",
        force: true,
        warning: "force delete skipped finalizer waits for session s1",
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the lifecycle metadata test and verify RED**

Run:

```bash
bun test src/core/lifecycle-metadata.test.ts
```

Expected: FAIL with module-not-found or missing export errors for `./lifecycle-metadata.js`.

- [ ] **Step 3: Implement lifecycle metadata types and helpers**

Create `src/core/lifecycle-metadata.ts`:

```ts
export type OwnerKind = "session" | "claim";

export interface OwnerRef {
  readonly kind: OwnerKind;
  readonly id: string;
  readonly uid: string;
}

export const Finalizer = {
  ReleaseSlots: "grove.io/release-slots",
  DrainContribs: "grove.io/drain-contribs",
  CloseRuntime: "grove.io/close-runtime",
} as const;
export type Finalizer = (typeof Finalizer)[keyof typeof Finalizer];

export const DEFAULT_SESSION_FINALIZERS: readonly Finalizer[] = [
  Finalizer.ReleaseSlots,
  Finalizer.DrainContribs,
  Finalizer.CloseRuntime,
];

export interface DeletionAuditEvent {
  readonly at: string;
  readonly actor: string;
  readonly force: boolean;
  readonly warning: string;
}

export function ownerRefsEqual(a: OwnerRef | undefined, b: OwnerRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.kind === b.kind && a.id === b.id && a.uid === b.uid;
}

export function appendDeletionAudit(
  existing: readonly DeletionAuditEvent[] | undefined,
  input: Pick<DeletionAuditEvent, "at" | "actor" | "warning">,
): readonly DeletionAuditEvent[] {
  return [...(existing ?? []), { ...input, force: true }];
}
```

Modify `src/core/models.ts`:

```ts
import type { Finalizer, OwnerRef } from "./lifecycle-metadata.js";
```

Add to `Claim`:

```ts
  readonly ownerRef?: OwnerRef | undefined;
  readonly finalizers?: readonly Finalizer[] | undefined;
  readonly deletionTimestamp?: string | undefined;
```

Modify `src/core/session.ts`:

```ts
import type { DeletionAuditEvent, Finalizer } from "./lifecycle-metadata.js";
```

Add to `Session`:

```ts
  readonly uid: string;
  readonly finalizers: readonly Finalizer[];
  readonly deletionTimestamp?: string | undefined;
  readonly deletionAudit?: readonly DeletionAuditEvent[] | undefined;
```

Modify `src/core/test-helpers.ts` so `makeClaim()` accepts ownership through normal overrides; no helper logic is needed after the type change.

- [ ] **Step 4: Add failing entity projection tests**

Append to `src/core/entity.test.ts`:

```ts
test("claimToEntity exposes owner refs, finalizers, and terminating condition", () => {
  const claim = makeClaim({
    ownerRef: { kind: "session", id: "s1", uid: "u1" },
    finalizers: [Finalizer.ReleaseSlots],
    deletionTimestamp: "2026-05-07T00:00:00.000Z",
  });

  const entity = claimToEntity(claim, () => Date.parse("2026-05-07T00:00:01.000Z"), "zone-a");

  expect(entity.metadata.ownerRefs).toEqual([{ kind: "session", id: "s1", uid: "u1" }]);
  expect(entity.metadata.finalizers).toEqual([Finalizer.ReleaseSlots]);
  expect(entity.metadata.deletionTimestamp).toBe("2026-05-07T00:00:00.000Z");
  expect(entity.conditions.find((c) => c.type === "Terminating")?.status).toBe("True");
});
```

Add imports:

```ts
import { Finalizer } from "./lifecycle-metadata.js";
import { makeClaim } from "./test-helpers.js";
```

- [ ] **Step 5: Run the entity projection test and verify RED**

Run:

```bash
bun test src/core/entity.test.ts --grep "claimToEntity exposes owner refs"
```

Expected: FAIL because `metadata.ownerRefs`, `metadata.finalizers`, `metadata.deletionTimestamp`, or `Terminating` condition is absent.

- [ ] **Step 6: Implement entity metadata projection**

Modify `src/core/entity.ts`:

```ts
import type { Finalizer, OwnerRef } from "./lifecycle-metadata.js";
```

Replace the local `OwnerRef` interface with the imported type, then extend `EntityMetadata`:

```ts
export interface EntityMetadata {
  readonly generation: number;
  readonly creationTimestamp?: string | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
  readonly ownerRefs?: readonly OwnerRef[] | undefined;
  readonly finalizers?: readonly Finalizer[] | undefined;
  readonly deletionTimestamp?: string | undefined;
}
```

In `claimToEntity()`, add:

```ts
  const terminatingCondition: Condition = mkCond(
    "Terminating",
    c.deletionTimestamp !== undefined,
    c.deletionTimestamp ?? c.heartbeatAt,
    c.deletionTimestamp !== undefined ? "deletion-requested" : effectivePhase,
  );

  const conditions: readonly Condition[] = [
    activeCondition,
    expiredCondition,
    completedCondition,
    terminatingCondition,
  ];
```

Then update claim metadata:

```ts
    metadata: {
      generation: metaGen,
      creationTimestamp: c.createdAt,
      ownerRefs: c.ownerRef !== undefined ? [c.ownerRef] : undefined,
      finalizers: c.finalizers,
      deletionTimestamp: c.deletionTimestamp,
    },
```

- [ ] **Step 7: Verify GREEN for core metadata**

Run:

```bash
bun test src/core/lifecycle-metadata.test.ts src/core/entity.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit core metadata**

```bash
git add src/core/lifecycle-metadata.ts src/core/lifecycle-metadata.test.ts src/core/models.ts src/core/session.ts src/core/entity.ts src/core/entity.test.ts src/core/test-helpers.ts
git commit -m "feat(core): add lifecycle metadata"
```

## Task 2: Store Contracts and In-Memory Behavior

**Files:**
- Modify: `src/core/session.ts`
- Modify: `src/core/store.ts`
- Modify: `src/core/session-store.conformance.ts`
- Modify: `src/core/claim-store.conformance.ts`
- Modify: `src/core/in-memory-session-store.ts`
- Modify: `src/server/test-helpers.ts`

- [ ] **Step 1: Add failing session-store deletion conformance tests**

Append to `src/core/session-store.conformance.ts` inside the conformance `describe`:

```ts
test("deleteSession removes an unblocked session", async () => {
  const session = await store.createSession({ goal: "delete me" });

  const result = await store.deleteSession(session.id);

  expect(result).toEqual({
    sessionId: session.id,
    deleted: true,
    forced: false,
    blockers: [],
  });
  expect(await store.getSession(session.id)).toBeUndefined();
});

test("deleteSession is idempotent for a missing session", async () => {
  const result = await store.deleteSession("missing-session");

  expect(result).toEqual({
    sessionId: "missing-session",
    deleted: false,
    forced: false,
    blockers: [{ finalizer: "grove.io/release-slots", message: "session not found" }],
  });
});

test("created sessions include uid and default finalizers", async () => {
  const session = await store.createSession({ goal: "metadata" });

  expect(session.uid).toBeTruthy();
  expect(session.finalizers).toEqual([
    "grove.io/release-slots",
    "grove.io/drain-contribs",
    "grove.io/close-runtime",
  ]);
});
```

- [ ] **Step 2: Run in-memory session tests and verify RED**

Run:

```bash
bun test src/core/in-memory-session-store.test.ts
```

Expected: FAIL because `SessionStore.deleteSession`, `listSessionDeleteBlockers`, `uid`, and `finalizers` are missing.

- [ ] **Step 3: Extend session store types**

Modify `src/core/session.ts`:

```ts
import type { Finalizer } from "./lifecycle-metadata.js";
```

Add:

```ts
export interface SessionDeleteOptions {
  readonly force?: boolean | undefined;
  readonly actor?: string | undefined;
}

export interface SessionDeleteBlocker {
  readonly finalizer: Finalizer;
  readonly message: string;
}

export interface SessionDeleteResult {
  readonly sessionId: string;
  readonly deleted: boolean;
  readonly forced: boolean;
  readonly blockers: readonly SessionDeleteBlocker[];
  readonly warning?: string | undefined;
  readonly cleanupErrors?: readonly string[] | undefined;
}
```

Add to `SessionStore`:

```ts
  deleteSession(id: string, options?: SessionDeleteOptions): Promise<SessionDeleteResult>;
  listSessionDeleteBlockers(id: string): Promise<readonly SessionDeleteBlocker[]>;
```

- [ ] **Step 4: Extend claim store types**

Modify `src/core/store.ts` imports:

```ts
import type { OwnerRef } from "./lifecycle-metadata.js";
```

Extend `ClaimQuery`:

```ts
  readonly ownerRef?: OwnerRef | undefined;
```

Add to `ClaimStore`:

```ts
  releaseOwnedBy(ownerRef: OwnerRef): Promise<number>;
  deleteTerminalOwnedBy(ownerRef: OwnerRef): Promise<number>;
```

- [ ] **Step 5: Implement in-memory session deletion**

Modify `src/core/in-memory-session-store.ts` imports:

```ts
import {
  DEFAULT_SESSION_FINALIZERS,
  Finalizer,
  appendDeletionAudit,
} from "./lifecycle-metadata.js";
import type {
  CreateSessionInput,
  Session,
  SessionDeleteOptions,
  SessionDeleteResult,
  SessionQuery,
  SessionStore,
} from "./session.js";
```

In `createSession()` add:

```ts
      uid: randomUUID(),
      finalizers: DEFAULT_SESSION_FINALIZERS,
```

Add methods:

```ts
  async listSessionDeleteBlockers(id: string): Promise<readonly { finalizer: Finalizer; message: string }[]> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return [{ finalizer: Finalizer.ReleaseSlots, message: "session not found" }];
    return [];
  }

  async deleteSession(id: string, options?: SessionDeleteOptions): Promise<SessionDeleteResult> {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) {
      return {
        sessionId: id,
        deleted: false,
        forced: false,
        blockers: [{ finalizer: Finalizer.ReleaseSlots, message: "session not found" }],
      };
    }
    const existing = this.sessions[idx];
    if (!existing) {
      return { sessionId: id, deleted: false, forced: false, blockers: [] };
    }
    const warning =
      options?.force === true ? `force delete skipped finalizer waits for session ${id}` : undefined;
    if (warning !== undefined) {
      this.sessions[idx] = {
        ...existing,
        deletionTimestamp: existing.deletionTimestamp ?? new Date().toISOString(),
        deletionAudit: appendDeletionAudit(existing.deletionAudit, {
          at: new Date().toISOString(),
          actor: options?.actor ?? "unknown",
          warning,
        }),
      };
    }
    this.sessions.splice(idx, 1);
    this.contributions.delete(id);
    return {
      sessionId: id,
      deleted: true,
      forced: options?.force === true,
      blockers: [],
      ...(warning !== undefined ? { warning } : {}),
    };
  }
```

- [ ] **Step 6: Update in-memory claim helpers used by server tests**

Modify `src/server/test-helpers.ts` `InMemoryClaimStore`:

```ts
import { ownerRefsEqual } from "../core/lifecycle-metadata.js";
```

In `listClaims()` add owner filtering:

```ts
    if (query?.ownerRef !== undefined) {
      claims = claims.filter((c) => ownerRefsEqual(c.ownerRef, query.ownerRef));
    }
```

Add:

```ts
  async releaseOwnedBy(ownerRef: import("../core/lifecycle-metadata.js").OwnerRef): Promise<number> {
    let count = 0;
    for (const claim of this.claims.values()) {
      if (claim.status === "active" && ownerRefsEqual(claim.ownerRef, ownerRef)) {
        this.claims.set(claim.claimId, {
          ...claim,
          status: "released",
          heartbeatAt: new Date().toISOString(),
          revision: (claim.revision ?? 1) + 1,
        });
        count++;
      }
    }
    return count;
  }

  async deleteTerminalOwnedBy(ownerRef: import("../core/lifecycle-metadata.js").OwnerRef): Promise<number> {
    let count = 0;
    for (const claim of this.claims.values()) {
      if (claim.status !== "active" && ownerRefsEqual(claim.ownerRef, ownerRef)) {
        this.claims.delete(claim.claimId);
        count++;
      }
    }
    return count;
  }
```

- [ ] **Step 7: Verify GREEN for in-memory store contract**

Run:

```bash
bun test src/core/in-memory-session-store.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit store contracts**

```bash
git add src/core/session.ts src/core/store.ts src/core/session-store.conformance.ts src/core/claim-store.conformance.ts src/core/in-memory-session-store.ts src/server/test-helpers.ts
git commit -m "feat(core): add session delete contracts"
```

## Task 3: Claim Ownership Stamping Through Operations

**Files:**
- Modify: `src/core/operations/deps.ts`
- Modify: `src/core/operations/claim.ts`
- Modify: `src/core/operations/claim.test.ts`
- Modify: `src/mcp/operation-adapter.ts`
- Modify: `src/mcp/serve.ts`
- Modify: `src/mcp/serve-http.ts`

- [ ] **Step 1: Write failing operation test for claim owner stamping**

Append to `src/core/operations/claim.test.ts`:

```ts
test("claimOperation stamps session ownerRef when deps provide one", async () => {
  const claimStore = new InMemoryClaimStore();
  const ownerRef = { kind: "session" as const, id: "s1", uid: "u1" };

  const result = await claimOperation(
    {
      targetRef: "owned-target",
      intentSummary: "owned work",
      agent: { agentId: "agent-a" },
    },
    { claimStore, sessionOwnerRef: ownerRef },
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const stored = await claimStore.getClaim(result.value.claimId);
  expect(stored?.ownerRef).toEqual(ownerRef);
});
```

Use the existing in-memory claim helper already imported in that test file. If the file uses a differently named helper, adapt only the helper name and keep the assertion unchanged.

- [ ] **Step 2: Run operation test and verify RED**

Run:

```bash
bun test src/core/operations/claim.test.ts --grep "stamps session ownerRef"
```

Expected: FAIL because `OperationDeps.sessionOwnerRef` is missing and `claimOperation` does not set `ownerRef`.

- [ ] **Step 3: Add `sessionOwnerRef` to operation deps and claim creation**

Modify `src/core/operations/deps.ts`:

```ts
import type { OwnerRef } from "../lifecycle-metadata.js";
```

Add to `OperationDeps`:

```ts
  readonly sessionOwnerRef?: OwnerRef | undefined;
```

Modify `src/core/operations/claim.ts` claim construction:

```ts
      ...(deps.sessionOwnerRef !== undefined ? { ownerRef: deps.sessionOwnerRef } : {}),
```

- [ ] **Step 4: Pass owner refs from MCP deps to operations**

Modify `src/mcp/operation-adapter.ts`:

```ts
    ...(deps.sessionOwnerRef !== undefined ? { sessionOwnerRef: deps.sessionOwnerRef } : {}),
```

Modify `src/mcp/deps.ts` by adding:

```ts
  readonly sessionOwnerRef?: import("../core/lifecycle-metadata.js").OwnerRef | undefined;
```

In `src/mcp/serve.ts`, after `envSessionId` is known and `runtime.goalSessionStore` is available, resolve:

```ts
  const sessionOwnerRef =
    envSessionId !== undefined
      ? await runtime.goalSessionStore.getSession(envSessionId).then((s) =>
          s !== undefined ? { kind: "session" as const, id: s.id, uid: s.uid } : undefined,
        )
      : undefined;
```

Add it to `deps`:

```ts
    ...(sessionOwnerRef !== undefined ? { sessionOwnerRef } : {}),
```

In `src/mcp/serve-http.ts`, use the bound Grove session id in the same way when constructing per-session `deps`. If Nexus mode only has `NexusSessionStore.getSessionRecord()`, use that record to build `{ kind: "session", id, uid }`.

- [ ] **Step 5: Verify operation owner stamping**

Run:

```bash
bun test src/core/operations/claim.test.ts src/mcp/deps-parity.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit owner stamping**

```bash
git add src/core/operations/deps.ts src/core/operations/claim.ts src/core/operations/claim.test.ts src/mcp/deps.ts src/mcp/operation-adapter.ts src/mcp/serve.ts src/mcp/serve-http.ts
git commit -m "feat(claims): stamp session owner refs"
```

## Task 4: SQLite Lifecycle Storage and Delete Finalizers

**Files:**
- Modify: `src/local/sqlite-store.ts`
- Modify: `src/local/sqlite-store.test.ts`
- Modify: `src/local/sqlite-goal-session-store.ts`
- Modify: `src/local/sqlite-goal-session-store.test.ts`

- [ ] **Step 1: Write failing SQLite session delete tests**

Append to `src/local/sqlite-goal-session-store.test.ts`:

```ts
describe("session deletion finalizers", () => {
  it("deleteSession releases owned claims and removes session contribution links", async () => {
    const session = await store.createSession({ goal: "cleanup" });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    const claim = makeClaim({ claimId: "owned-claim", targetRef: "owned-target", ownerRef });
    await stores.claimStore.createClaim(claim);
    const contribution = makeContribution({ summary: "owned contribution" });
    await stores.contributionStore.put(contribution);
    await store.addContributionToSession(session.id, contribution.cid);

    const result = await store.deleteSession(session.id);

    expect(result.deleted).toBe(true);
    expect(result.forced).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(await store.getSession(session.id)).toBeUndefined();
    expect(await stores.claimStore.getClaim("owned-claim")).toBeUndefined();
    expect(await store.getSessionContributions(session.id)).toEqual([]);
    expect(await stores.contributionStore.get(contribution.cid)).toBeDefined();
  });

  it("deleteSession returns blockers when close-runtime finalizer fails", async () => {
    const blocking = new SqliteGoalSessionStore(stores.db, {
      closeRuntime: async () => {
        throw new Error("runtime still flushing");
      },
    });
    const session = await blocking.createSession({ goal: "blocked" });

    const result = await blocking.deleteSession(session.id);

    expect(result.deleted).toBe(false);
    expect(result.blockers).toEqual([
      { finalizer: "grove.io/close-runtime", message: "runtime still flushing" },
    ]);
    const fetched = await blocking.getSession(session.id);
    expect(fetched?.deletionTimestamp).toBeDefined();
    expect(fetched?.finalizers).toEqual(["grove.io/close-runtime"]);
  });

  it("deleteSession force removes session and returns warning", async () => {
    const blocking = new SqliteGoalSessionStore(stores.db, {
      closeRuntime: async () => {
        throw new Error("runtime still flushing");
      },
    });
    const session = await blocking.createSession({ goal: "force" });

    const result = await blocking.deleteSession(session.id, { force: true, actor: "test" });

    expect(result.deleted).toBe(true);
    expect(result.forced).toBe(true);
    expect(result.warning).toContain("force delete skipped finalizer waits");
    expect(await blocking.getSession(session.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run SQLite session tests and verify RED**

Run:

```bash
bun test src/local/sqlite-goal-session-store.test.ts --grep "session deletion finalizers"
```

Expected: FAIL because SQLite schema columns, constructor options, and delete methods are missing.

- [ ] **Step 3: Add SQLite schema columns and row mapping**

Modify `src/local/sqlite-store.ts`:

```ts
export const CURRENT_SCHEMA_VERSION = 14;
```

Add to `SCHEMA_DDL` `claims` table:

```sql
    owner_ref_json TEXT,
    finalizers_json TEXT NOT NULL DEFAULT '[]',
    deletion_timestamp TEXT,
```

In column-safe migrations, add missing claim columns:

```ts
      if (!columnNames.has("owner_ref_json")) {
        db.run("ALTER TABLE claims ADD COLUMN owner_ref_json TEXT");
      }
      if (!columnNames.has("finalizers_json")) {
        db.run("ALTER TABLE claims ADD COLUMN finalizers_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!columnNames.has("deletion_timestamp")) {
        db.run("ALTER TABLE claims ADD COLUMN deletion_timestamp TEXT");
      }
```

Modify `ClaimRow`, `CLAIM_SELECT_COLS`, `rowToClaim()`, and `insertClaimRow()` to round-trip:

```ts
readonly owner_ref_json: string | null;
readonly finalizers_json: string;
readonly deletion_timestamp: string | null;
```

and:

```ts
    ...(row.owner_ref_json !== null
      ? { ownerRef: JSON.parse(row.owner_ref_json) as OwnerRef }
      : {}),
    finalizers: JSON.parse(row.finalizers_json) as readonly Finalizer[],
    ...(row.deletion_timestamp !== null ? { deletionTimestamp: row.deletion_timestamp } : {}),
```

- [ ] **Step 4: Add SQLite session schema migration and mapping**

Modify `src/local/sqlite-goal-session-store.ts` `GOAL_SESSION_DDL` sessions table:

```sql
    uid TEXT NOT NULL,
    finalizers_json TEXT NOT NULL DEFAULT '[]',
    deletion_timestamp TEXT,
    deletion_audit_json TEXT NOT NULL DEFAULT '[]',
```

Add to `session_contributions`:

```sql
    owner_ref_json TEXT,
```

Update `SessionRow`, `SessionListRow`, `rowToSession()`, and `listRowToSession()` to include:

```ts
uid: row.uid,
finalizers: JSON.parse(row.finalizers_json) as readonly Finalizer[],
deletionTimestamp: row.deletion_timestamp ?? undefined,
deletionAudit: JSON.parse(row.deletion_audit_json) as readonly DeletionAuditEvent[],
```

Update `createSession()` insert to generate:

```ts
const uid = crypto.randomUUID();
const finalizersJson = JSON.stringify(DEFAULT_SESSION_FINALIZERS);
```

and return `uid` plus `finalizers: DEFAULT_SESSION_FINALIZERS`.

In `src/local/sqlite-store.ts` session table migration, add column-safe session columns and backfill:

```ts
if (!sessionColNames.has("uid")) {
  db.run("ALTER TABLE sessions ADD COLUMN uid TEXT");
  const rows = db.prepare("SELECT session_id FROM sessions WHERE uid IS NULL OR uid = ''").all() as readonly { session_id: string }[];
  const update = db.prepare("UPDATE sessions SET uid = ? WHERE session_id = ?");
  for (const row of rows) update.run(crypto.randomUUID(), row.session_id);
}
if (!sessionColNames.has("finalizers_json")) {
  db.run("ALTER TABLE sessions ADD COLUMN finalizers_json TEXT NOT NULL DEFAULT '[]'");
}
if (!sessionColNames.has("deletion_timestamp")) {
  db.run("ALTER TABLE sessions ADD COLUMN deletion_timestamp TEXT");
}
if (!sessionColNames.has("deletion_audit_json")) {
  db.run("ALTER TABLE sessions ADD COLUMN deletion_audit_json TEXT NOT NULL DEFAULT '[]'");
}
```

Add a session contribution migration:

```ts
const scCols = db.prepare("PRAGMA table_info(session_contributions)").all() as readonly { name: string }[];
if (scCols.length > 0 && !new Set(scCols.map((c) => c.name)).has("owner_ref_json")) {
  db.run("ALTER TABLE session_contributions ADD COLUMN owner_ref_json TEXT");
}
```

- [ ] **Step 5: Implement owner-aware SQLite claim helpers**

Modify `src/local/sqlite-store.ts` `SqliteClaimStore.listClaims()` to filter by owner:

```ts
    if (query?.ownerRef !== undefined) {
      sql += " AND owner_ref_json = ?";
      params.push(JSON.stringify(query.ownerRef));
    }
```

Add methods:

```ts
  releaseOwnedBy = async (ownerRef: OwnerRef): Promise<number> => {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `UPDATE claims
         SET status = 'released', heartbeat_at = ?, revision = revision + 1
         WHERE status = 'active' AND owner_ref_json = ?
         RETURNING ${CLAIM_SELECT_COLS}`,
      )
      .all(now, JSON.stringify(ownerRef)) as readonly ClaimRow[];
    for (const row of rows) this.onClaimWrite?.("MODIFIED", rowToClaim(row));
    return rows.length;
  };

  deleteTerminalOwnedBy = async (ownerRef: OwnerRef): Promise<number> => {
    const rows = this.db
      .prepare(
        `SELECT ${CLAIM_SELECT_COLS} FROM claims
         WHERE status IN ('completed', 'expired', 'released') AND owner_ref_json = ?`,
      )
      .all(JSON.stringify(ownerRef)) as readonly ClaimRow[];
    const result = this.db
      .prepare(
        `DELETE FROM claims
         WHERE status IN ('completed', 'expired', 'released') AND owner_ref_json = ?`,
      )
      .run(JSON.stringify(ownerRef));
    for (const row of rows) this.onClaimWrite?.("DELETED", rowToClaim(row));
    return result.changes;
  };
```

- [ ] **Step 6: Implement SQLite session delete orchestration**

Modify `src/local/sqlite-goal-session-store.ts` constructor:

```ts
export interface SqliteGoalSessionStoreOptions {
  readonly closeRuntime?: ((session: Session) => Promise<void>) | undefined;
}

constructor(db: Database, options?: SqliteGoalSessionStoreOptions) {
  this.db = db;
  this.closeRuntime = options?.closeRuntime;
  db.exec(GOAL_SESSION_DDL);
}
```

Add private helpers:

```ts
private ownerRefForSession(session: Session): OwnerRef {
  return { kind: "session", id: session.id, uid: session.uid };
}

private forceWarning(sessionId: string): string {
  return `force delete skipped finalizer waits for session ${sessionId}`;
}
```

Implement `deleteSession()`:

```ts
deleteSession = async (
  sessionId: string,
  options?: SessionDeleteOptions,
): Promise<SessionDeleteResult> => {
  const existing = await this.getSession(sessionId);
  if (existing === undefined) {
    return {
      sessionId,
      deleted: false,
      forced: false,
      blockers: [{ finalizer: Finalizer.ReleaseSlots, message: "session not found" }],
    };
  }
  const warning = options?.force === true ? this.forceWarning(sessionId) : undefined;
  const ownerRef = this.ownerRefForSession(existing);

  if (options?.force === true) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE sessions SET deletion_timestamp = COALESCE(deletion_timestamp, ?), deletion_audit_json = ? WHERE session_id = ?").run(
        now,
        JSON.stringify(appendDeletionAudit(existing.deletionAudit, { at: now, actor: options.actor ?? "unknown", warning: warning ?? this.forceWarning(sessionId) })),
        sessionId,
      );
      this.db.prepare("UPDATE claims SET status = 'released', heartbeat_at = ?, revision = revision + 1 WHERE status = 'active' AND owner_ref_json = ?").run(now, JSON.stringify(ownerRef));
      this.db.prepare("DELETE FROM claims WHERE status IN ('completed', 'expired', 'released') AND owner_ref_json = ?").run(JSON.stringify(ownerRef));
      this.db.prepare("DELETE FROM session_contributions WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
    }).immediate();
    return { sessionId, deleted: true, forced: true, blockers: [], warning };
  }

  const blockers: SessionDeleteBlocker[] = [];
  let finalizers = existing.finalizers.length > 0 ? [...existing.finalizers] : [...DEFAULT_SESSION_FINALIZERS];
  this.db.prepare("UPDATE sessions SET deletion_timestamp = COALESCE(deletion_timestamp, ?), finalizers_json = ? WHERE session_id = ?").run(
    new Date().toISOString(),
    JSON.stringify(finalizers),
    sessionId,
  );

  if (finalizers.includes(Finalizer.ReleaseSlots)) {
    this.db.prepare("UPDATE claims SET status = 'released', heartbeat_at = ?, revision = revision + 1 WHERE status = 'active' AND owner_ref_json = ?").run(new Date().toISOString(), JSON.stringify(ownerRef));
    this.db.prepare("DELETE FROM claims WHERE status IN ('completed', 'expired', 'released') AND owner_ref_json = ?").run(JSON.stringify(ownerRef));
    finalizers = finalizers.filter((f) => f !== Finalizer.ReleaseSlots);
  }

  if (finalizers.includes(Finalizer.DrainContribs)) {
    this.db.prepare("DELETE FROM session_contributions WHERE session_id = ?").run(sessionId);
    finalizers = finalizers.filter((f) => f !== Finalizer.DrainContribs);
  }

  if (finalizers.includes(Finalizer.CloseRuntime)) {
    if (this.closeRuntime !== undefined) {
      try {
        await this.closeRuntime(existing);
        finalizers = finalizers.filter((f) => f !== Finalizer.CloseRuntime);
      } catch (err) {
        blockers.push({
          finalizer: Finalizer.CloseRuntime,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      finalizers = finalizers.filter((f) => f !== Finalizer.CloseRuntime);
    }
  }

  this.db.prepare("UPDATE sessions SET finalizers_json = ? WHERE session_id = ?").run(
    JSON.stringify(finalizers),
    sessionId,
  );
  if (blockers.length > 0 || finalizers.length > 0) {
    return { sessionId, deleted: false, forced: false, blockers };
  }
  this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  return { sessionId, deleted: true, forced: false, blockers: [] };
};
```

Implement `listSessionDeleteBlockers()`:

```ts
listSessionDeleteBlockers = async (sessionId: string): Promise<readonly SessionDeleteBlocker[]> => {
  const session = await this.getSession(sessionId);
  if (session === undefined) {
    return [{ finalizer: Finalizer.ReleaseSlots, message: "session not found" }];
  }
  const ownerRefJson = JSON.stringify(this.ownerRefForSession(session));
  const blockers: SessionDeleteBlocker[] = [];
  const activeOwned = this.db
    .prepare("SELECT COUNT(*) as cnt FROM claims WHERE status = 'active' AND owner_ref_json = ?")
    .get(ownerRefJson) as { cnt: number } | null;
  if ((activeOwned?.cnt ?? 0) > 0) {
    blockers.push({
      finalizer: Finalizer.ReleaseSlots,
      message: `${activeOwned?.cnt ?? 0} active claim(s) still owned by this session`,
    });
  }
  const linkedContribs = this.db
    .prepare("SELECT COUNT(*) as cnt FROM session_contributions WHERE session_id = ?")
    .get(sessionId) as { cnt: number } | null;
  if ((linkedContribs?.cnt ?? 0) > 0) {
    blockers.push({
      finalizer: Finalizer.DrainContribs,
      message: `${linkedContribs?.cnt ?? 0} contribution link(s) still owned by this session`,
    });
  }
  if (session.finalizers.includes(Finalizer.CloseRuntime) && this.closeRuntime !== undefined) {
    blockers.push({
      finalizer: Finalizer.CloseRuntime,
      message: "runtime cleanup has not completed",
    });
  }
  return blockers;
};
```

- [ ] **Step 7: Stamp session contribution owner refs**

Modify `addContributionToSession()`:

```ts
const session = await this.getSession(sessionId);
const ownerRefJson =
  session !== undefined ? JSON.stringify({ kind: "session", id: session.id, uid: session.uid }) : null;
this.stmtInsertContribution.run(sessionId, cid, addedAt, ownerRefJson);
```

Update the prepared statement to include `owner_ref_json`.

- [ ] **Step 8: Verify SQLite store behavior**

Run:

```bash
bun test src/local/sqlite-goal-session-store.test.ts src/local/sqlite-store.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit SQLite implementation**

```bash
git add src/local/sqlite-store.ts src/local/sqlite-store.test.ts src/local/sqlite-goal-session-store.ts src/local/sqlite-goal-session-store.test.ts
git commit -m "feat(local): cascade delete sessions with finalizers"
```

## Task 5: Nexus Lifecycle Storage and Delete Finalizers

**Files:**
- Modify: `src/nexus/nexus-claim-store.ts`
- Modify: `src/nexus/nexus-claim-store.test.ts`
- Modify: `src/nexus/nexus-session-store.ts`
- Modify: `src/nexus/nexus-session-store.test.ts`

- [ ] **Step 1: Write failing Nexus sidecar and delete tests**

Append to `src/nexus/nexus-session-store.test.ts`:

```ts
it("reads legacy contribution sidecar arrays and rewrites versioned owned links", async () => {
  const client = createMockClient();
  const store = new NexusSessionStore(client, "test-zone");
  const session = await store.createSession({ goal: "sidecar" });
  await client.write(
    `/zones/test-zone/sessions/${session.id}.contributions.json`,
    new TextEncoder().encode(JSON.stringify(["blake3:legacy"])),
  );

  expect(await store.getContributions(session.id)).toEqual(["blake3:legacy"]);

  await store.addContribution(session.id, "blake3:new");
  const raw = await client.read(`/zones/test-zone/sessions/${session.id}.contributions.json`);
  const parsed = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array())) as {
    version: number;
    items: readonly { cid: string; ownerRef: { kind: string; id: string; uid: string } }[];
  };

  expect(parsed.version).toBe(2);
  expect(parsed.items.map((i) => i.cid)).toEqual(["blake3:legacy", "blake3:new"]);
  expect(parsed.items[0]?.ownerRef).toEqual({ kind: "session", id: session.id, uid: session.uid });
});

it("deleteSession removes Nexus session records and contribution sidecar", async () => {
  const client = createMockClient();
  const store = new NexusSessionStore(client, "test-zone");
  const session = await store.createSession({ goal: "delete" });
  await store.addContribution(session.id, "blake3:cid");

  const result = await store.deleteSession(session.id);

  expect(result.deleted).toBe(true);
  expect(await store.getSession(session.id)).toBeUndefined();
  expect(await client.exists(`/zones/test-zone/sessions/${session.id}.contributions.json`)).toBe(false);
});
```

- [ ] **Step 2: Run Nexus session tests and verify RED**

Run:

```bash
bun test src/nexus/nexus-session-store.test.ts --grep "sidecar|deleteSession"
```

Expected: FAIL because sessions lack `uid`, sidecars are raw arrays, and `deleteSession` is missing.

- [ ] **Step 3: Implement Nexus session metadata and sidecar compatibility**

Modify `src/nexus/nexus-session-store.ts`:

```ts
import {
  DEFAULT_SESSION_FINALIZERS,
  Finalizer,
  appendDeletionAudit,
} from "../core/lifecycle-metadata.js";
import type { OwnerRef } from "../core/lifecycle-metadata.js";
```

Add sidecar types:

```ts
interface SessionContributionLink {
  readonly cid: string;
  readonly ownerRef: OwnerRef;
  readonly addedAt: string;
}

interface SessionContributionSidecarV2 {
  readonly version: 2;
  readonly items: readonly SessionContributionLink[];
}
```

In `createSession()` include:

```ts
      uid: randomUUID(),
      finalizers: DEFAULT_SESSION_FINALIZERS,
```

In `getSessionRecord()`, normalize legacy records:

```ts
const parsed = JSON.parse(decoder.decode(data)) as Session;
return {
  ...parsed,
  uid: parsed.uid ?? randomUUID(),
  finalizers: parsed.finalizers ?? DEFAULT_SESSION_FINALIZERS,
};
```

Add helpers:

```ts
private ownerRefFor(session: Session): OwnerRef {
  return { kind: "session", id: session.id, uid: session.uid };
}

private async readContributionLinks(session: Session): Promise<readonly SessionContributionLink[]> {
  const data = await this.client.read(this.contributionsPath(session.id));
  if (!data) return [];
  const parsed = JSON.parse(decoder.decode(data)) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.map((cid) => ({
      cid: String(cid),
      ownerRef: this.ownerRefFor(session),
      addedAt: session.createdAt,
    }));
  }
  const sidecar = parsed as SessionContributionSidecarV2;
  return sidecar.items;
}

private async writeContributionLinks(session: Session, links: readonly SessionContributionLink[]): Promise<void> {
  await this.client.write(
    this.contributionsPath(session.id),
    encoder.encode(JSON.stringify({ version: 2, items: links } satisfies SessionContributionSidecarV2)),
  );
}
```

Use these helpers in `addContribution()` and `getContributions()`.

- [ ] **Step 4: Implement Nexus claim owner helpers**

Modify `src/nexus/nexus-claim-store.ts` `listClaims()` to filter by `query.ownerRef` using `ownerRefsEqual()` after loading claim files.

Add:

```ts
async releaseOwnedBy(ownerRef: OwnerRef): Promise<number> {
  const claims = await this.listClaims({ ownerRef, status: "active" });
  let count = 0;
  for (const claim of claims) {
    await this.release(claim.claimId);
    count++;
  }
  return count;
}

async deleteTerminalOwnedBy(ownerRef: OwnerRef): Promise<number> {
  const claims = await this.listClaims({
    ownerRef,
    status: ["completed", "expired", "released"],
  });
  let count = 0;
  for (const claim of claims) {
    await withSemaphore(this.semaphore, () => this.client.delete(claimPath(this.zoneId, claim.claimId)));
    this.claimCache.delete(claim.claimId);
    this.publishWatch(claim, "DELETED");
    count++;
  }
  this.invalidateActiveClaimsCache();
  return count;
}
```

If `LruCache` has no `delete()` method, add that method to `src/nexus/lru-cache.ts` with a focused test in `src/nexus/lru-cache.test.ts`.

- [ ] **Step 5: Implement Nexus session delete**

Extend `NexusSessionStore` constructor:

```ts
export interface NexusSessionStoreOptions {
  readonly claimStore?: ClaimStore | undefined;
  readonly closeRuntime?: ((session: Session) => Promise<void>) | undefined;
}

constructor(client: NexusClient, zoneId: string, options?: NexusSessionStoreOptions) {
  this.client = client;
  this.zoneId = zoneId;
  this.claimStore = options?.claimStore;
  this.closeRuntime = options?.closeRuntime;
}
```

Implement `deleteSession()` and `listSessionDeleteBlockers()`:

```ts
async listSessionDeleteBlockers(id: string): Promise<readonly SessionDeleteBlocker[]> {
  const session = await this.getSessionRecord(id);
  if (session === undefined) {
    return [{ finalizer: Finalizer.ReleaseSlots, message: "session not found" }];
  }
  const blockers: SessionDeleteBlocker[] = [];
  const ownerRef = this.ownerRefFor(session);
  const ownedClaims =
    this.claimStore !== undefined
      ? await this.claimStore.listClaims({ ownerRef, status: "active" })
      : [];
  if (ownedClaims.length > 0) {
    blockers.push({
      finalizer: Finalizer.ReleaseSlots,
      message: `${ownedClaims.length} active claim(s) still owned by this session`,
    });
  }
  const links = await this.readContributionLinks(session);
  if (links.length > 0) {
    blockers.push({
      finalizer: Finalizer.DrainContribs,
      message: `${links.length} contribution link(s) still owned by this session`,
    });
  }
  if (session.finalizers.includes(Finalizer.CloseRuntime) && this.closeRuntime !== undefined) {
    blockers.push({
      finalizer: Finalizer.CloseRuntime,
      message: "runtime cleanup has not completed",
    });
  }
  return blockers;
}

async deleteSession(id: string, options?: SessionDeleteOptions): Promise<SessionDeleteResult> {
  const session = await this.getSessionRecord(id);
  if (session === undefined) {
    return {
      sessionId: id,
      deleted: false,
      forced: false,
      blockers: [{ finalizer: Finalizer.ReleaseSlots, message: "session not found" }],
    };
  }
  const now = new Date().toISOString();
  const warning =
    options?.force === true ? `force delete skipped finalizer waits for session ${id}` : undefined;
  const marked: Session = {
    ...session,
    deletionTimestamp: session.deletionTimestamp ?? now,
    finalizers: session.finalizers.length > 0 ? session.finalizers : DEFAULT_SESSION_FINALIZERS,
    ...(warning !== undefined
      ? {
          deletionAudit: appendDeletionAudit(session.deletionAudit, {
            at: now,
            actor: options?.actor ?? "unknown",
            warning,
          }),
        }
      : {}),
  };
  await this.putSession(marked);

  const ownerRef = this.ownerRefFor(marked);
  const cleanupErrors: string[] = [];
  if (options?.force === true) {
    try {
      await this.claimStore?.releaseOwnedBy(ownerRef);
      await this.claimStore?.deleteTerminalOwnedBy(ownerRef);
      await this.client.delete(this.contributionsPath(id));
    } catch (err) {
      cleanupErrors.push(err instanceof Error ? err.message : String(err));
    }
    await this.client.delete(this.sessionPath(id));
    return {
      sessionId: id,
      deleted: true,
      forced: true,
      blockers: [],
      warning,
      ...(cleanupErrors.length > 0 ? { cleanupErrors } : {}),
    };
  }

  let finalizers = [...marked.finalizers];
  const blockers: SessionDeleteBlocker[] = [];
  if (finalizers.includes(Finalizer.ReleaseSlots)) {
    await this.claimStore?.releaseOwnedBy(ownerRef);
    await this.claimStore?.deleteTerminalOwnedBy(ownerRef);
    finalizers = finalizers.filter((f) => f !== Finalizer.ReleaseSlots);
  }
  if (finalizers.includes(Finalizer.DrainContribs)) {
    await this.client.delete(this.contributionsPath(id));
    finalizers = finalizers.filter((f) => f !== Finalizer.DrainContribs);
  }
  if (finalizers.includes(Finalizer.CloseRuntime)) {
    if (this.closeRuntime !== undefined) {
      try {
        await this.closeRuntime(marked);
        finalizers = finalizers.filter((f) => f !== Finalizer.CloseRuntime);
      } catch (err) {
        blockers.push({
          finalizer: Finalizer.CloseRuntime,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      finalizers = finalizers.filter((f) => f !== Finalizer.CloseRuntime);
    }
  }
  await this.putSession({ ...marked, finalizers });
  if (blockers.length > 0 || finalizers.length > 0) {
    return { sessionId: id, deleted: false, forced: false, blockers };
  }
  await this.client.delete(this.sessionPath(id));
  return { sessionId: id, deleted: true, forced: false, blockers: [] };
}
```

- [ ] **Step 6: Verify Nexus behavior**

Run:

```bash
bun test src/nexus/nexus-session-store.test.ts src/nexus/nexus-claim-store.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Nexus implementation**

```bash
git add src/nexus/nexus-session-store.ts src/nexus/nexus-session-store.test.ts src/nexus/nexus-claim-store.ts src/nexus/nexus-claim-store.test.ts src/nexus/lru-cache.ts src/nexus/lru-cache.test.ts
git commit -m "feat(nexus): cascade delete sessions with finalizers"
```

## Task 6: HTTP and MCP Session Delete Surfaces

**Files:**
- Create: `src/server/routes/sessions.test.ts`
- Modify: `src/server/deps.ts`
- Modify: `src/server/routes/sessions.ts`
- Modify: `src/mcp/tools/session.ts`
- Modify: `src/mcp/tools/session.test.ts`
- Modify: `src/mcp/server.test.ts`

- [ ] **Step 1: Write failing HTTP route tests**

Create `src/server/routes/sessions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { InMemorySessionStore } from "../../core/in-memory-session-store.js";
import { createTestApp } from "../test-helpers.js";

describe("session delete routes", () => {
  test("DELETE /api/sessions/:id deletes a session", async () => {
    const ctx = createTestApp();
    const goalSessionStore = new InMemorySessionStore();
    ctx.deps.goalSessionStore = goalSessionStore;
    const session = await goalSessionStore.createSession({ goal: "delete" });

    const res = await ctx.app.request(`/api/sessions/${session.id}`, { method: "DELETE" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ sessionId: session.id, deleted: true, forced: false });
  });

  test("GET /api/sessions/:id/delete-blockers returns blocker list", async () => {
    const ctx = createTestApp();
    const goalSessionStore = new InMemorySessionStore();
    ctx.deps.goalSessionStore = goalSessionStore;
    const session = await goalSessionStore.createSession({ goal: "blockers" });

    const res = await ctx.app.request(`/api/sessions/${session.id}/delete-blockers`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ sessionId: session.id, blockers: [] });
  });
});
```

If `createTestApp()` returns immutable deps, follow the existing test-helper pattern and pass a `deps` override at construction instead of mutating.

- [ ] **Step 2: Run HTTP route test and verify RED**

Run:

```bash
bun test src/server/routes/sessions.test.ts
```

Expected: FAIL because routes are missing.

- [ ] **Step 3: Implement HTTP routes**

Modify `src/server/routes/sessions.ts` route comment header to include:

```ts
 * DELETE /api/sessions/:id — Delete a session with finalizer cleanup.
 * GET /api/sessions/:id/delete-blockers — Inspect delete blockers.
```

Add before `GET /:id` so `delete-blockers` is not parsed as a session id:

```ts
sessions.get("/:id/delete-blockers", async (c) => {
  const { goalSessionStore } = c.get("deps");
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");
  const sessionId = c.req.param("id");
  const session = await goalSessionStore.getSession(sessionId);
  if (!session) {
    return c.json({ error: { code: "NOT_FOUND", message: `Session not found: ${sessionId}` } }, 404);
  }
  const blockers = await goalSessionStore.listSessionDeleteBlockers(sessionId);
  return c.json({ sessionId, blockers });
});

sessions.delete("/:id", async (c) => {
  const { goalSessionStore } = c.get("deps");
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");
  const sessionId = c.req.param("id");
  const session = await goalSessionStore.getSession(sessionId);
  if (!session) {
    return c.json({ error: { code: "NOT_FOUND", message: `Session not found: ${sessionId}` } }, 404);
  }
  const force = c.req.query("force") === "true";
  const result = await goalSessionStore.deleteSession(sessionId, { force, actor: "http" });
  return c.json(result, result.deleted || force ? 200 : 409);
});
```

Update `toSessionResponse()` to include:

```ts
uid: session.uid,
finalizers: session.finalizers,
deletionTimestamp: session.deletionTimestamp,
deletionAudit: session.deletionAudit,
```

- [ ] **Step 4: Add failing MCP session tool tests**

Append to `src/mcp/tools/session.test.ts`:

```ts
describe("grove_delete_session", () => {
  test("deletes an existing session", async () => {
    const session = await deps.goalSessionStore!.createSession({ goal: "delete" });

    const result = await callTool(server, "grove_delete_session", { sessionId: session.id });
    const data = JSON.parse(result.content[0]!.text);

    expect(data.deleted).toBe(true);
    expect(data.sessionId).toBe(session.id);
  });
});

describe("grove_session_delete_blockers", () => {
  test("returns blockers for a session", async () => {
    const session = await deps.goalSessionStore!.createSession({ goal: "blockers" });

    const result = await callTool(server, "grove_session_delete_blockers", {
      sessionId: session.id,
    });
    const data = JSON.parse(result.content[0]!.text);

    expect(data).toEqual({ sessionId: session.id, blockers: [] });
  });
});
```

- [ ] **Step 5: Run MCP tests and verify RED**

Run:

```bash
bun test src/mcp/tools/session.test.ts src/mcp/server.test.ts --grep "delete_session|session_delete_blockers|registered"
```

Expected: FAIL because MCP tools are missing from registration and expected tool lists.

- [ ] **Step 6: Implement MCP tools**

Modify `src/mcp/tools/session.ts` schemas:

```ts
const deleteSessionInputSchema = z.object({
  sessionId: z.string().min(1),
  force: z.boolean().optional().default(false),
  actor: z.string().optional().default("mcp"),
});

const deleteBlockersInputSchema = z.object({
  sessionId: z.string().min(1),
});
```

Register:

```ts
  server.registerTool(
    "grove_delete_session",
    {
      description: "Delete a session after running finalizer cleanup. Pass force=true to skip finalizer waits with a warning.",
      inputSchema: deleteSessionInputSchema,
    },
    async (args) => {
      const store = deps.goalSessionStore;
      if (!store) return toolError("NOT_CONFIGURED", "Goal/session store is not configured");
      const session = await store.getSession(args.sessionId);
      if (!session) return toolError("NOT_FOUND", `Session not found: ${args.sessionId}`);
      const result = await store.deleteSession(args.sessionId, {
        force: args.force ?? false,
        actor: args.actor ?? "mcp",
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "grove_session_delete_blockers",
    {
      description: "Inspect finalizers blocking session deletion.",
      inputSchema: deleteBlockersInputSchema,
    },
    async (args) => {
      const store = deps.goalSessionStore;
      if (!store) return toolError("NOT_CONFIGURED", "Goal/session store is not configured");
      const session = await store.getSession(args.sessionId);
      if (!session) return toolError("NOT_FOUND", `Session not found: ${args.sessionId}`);
      const blockers = await store.listSessionDeleteBlockers(args.sessionId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ sessionId: args.sessionId, blockers }) }],
      };
    },
  );
```

Update `src/mcp/server.test.ts` expected tool names to include `grove_delete_session` and `grove_session_delete_blockers`.

- [ ] **Step 7: Verify HTTP and MCP surfaces**

Run:

```bash
bun test src/server/routes/sessions.test.ts src/mcp/tools/session.test.ts src/mcp/server.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit API surfaces**

```bash
git add src/server/deps.ts src/server/routes/sessions.ts src/server/routes/sessions.test.ts src/mcp/tools/session.ts src/mcp/tools/session.test.ts src/mcp/server.test.ts
git commit -m "feat(api): expose session delete finalizers"
```

## Task 7: CLI Session Delete

**Files:**
- Modify: `src/cli/commands/session.ts`
- Modify: `src/cli/main.integration.test.ts`

- [ ] **Step 1: Write failing CLI integration test**

Append to `src/cli/main.integration.test.ts` near existing session command tests:

```ts
test("session delete removes a session and prints force warning", async () => {
  const dir = await makeTempGrove();
  const create = await runGrove(dir, ["session", "start", "--goal", "delete me", "--runtime", "mock"]);
  expect(create.exitCode).toBe(0);
  const created = JSON.parse(create.stdout) as { sessionId: string };

  const deleted = await runGrove(dir, ["session", "delete", created.sessionId, "--force"]);
  expect(deleted.exitCode).toBe(0);
  const data = JSON.parse(deleted.stdout) as {
    sessionId: string;
    deleted: boolean;
    forced: boolean;
    warning?: string;
  };

  expect(data.sessionId).toBe(created.sessionId);
  expect(data.deleted).toBe(true);
  expect(data.forced).toBe(true);
  expect(data.warning).toContain("force delete skipped finalizer waits");
});
```

Use the existing temp-grove and CLI runner helpers already defined in the file. If the current `session start` integration waits too long for this test, create a session directly through the SQLite store in the test setup and invoke only `grove session delete`.

- [ ] **Step 2: Run CLI test and verify RED**

Run:

```bash
bun test src/cli/main.integration.test.ts --grep "session delete"
```

Expected: FAIL because `grove session delete` is not implemented.

- [ ] **Step 3: Implement CLI subcommand**

Modify `src/cli/commands/session.ts` dispatch:

```ts
    case "delete":
      return sessionDelete(rest);
```

Update help:

```text
  delete <session-id> [--force]                           Delete a session after finalizer cleanup
```

Add function:

```ts
async function sessionDelete(args: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  const sessionId = positionals[0];
  if (!sessionId) {
    outputJsonError({ code: "VALIDATION_ERROR", message: "session id is required" });
    process.exitCode = 1;
    return;
  }

  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { resolveGroveDir } = await import("../utils/grove-dir.js");
  try {
    const { groveDir } = resolveGroveDir();
    const dbPath = join(groveDir, "grove.db");
    if (!existsSync(dbPath)) {
      outputJsonError({ code: "NOT_FOUND", message: "No grove database found" });
      process.exitCode = 1;
      return;
    }
    const { initSqliteDb } = await import("../../local/sqlite-store.js");
    const db = initSqliteDb(dbPath);
    const store = new SqliteGoalSessionStore(db);
    const session = await store.getSession(sessionId);
    if (!session) {
      db.close();
      outputJsonError({ code: "NOT_FOUND", message: `Session not found: ${sessionId}` });
      process.exitCode = 1;
      return;
    }
    const result = await store.deleteSession(sessionId, {
      force: values.force as boolean,
      actor: "cli",
    });
    db.close();
    if (!result.deleted && !result.forced) process.exitCode = 1;
    outputJson(result);
  } catch (err) {
    outputJsonError({
      code: "SESSION_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Verify CLI delete**

Run:

```bash
bun test src/cli/main.integration.test.ts --grep "session delete"
```

Expected: PASS.

- [ ] **Step 5: Commit CLI surface**

```bash
git add src/cli/commands/session.ts src/cli/main.integration.test.ts
git commit -m "feat(cli): delete sessions with finalizers"
```

## Task 8: Full Verification and Integration Cleanup

**Files:**
- Review all files changed by Tasks 1-7.

- [ ] **Step 1: Run focused feature tests**

```bash
bun test \
  src/core/lifecycle-metadata.test.ts \
  src/core/entity.test.ts \
  src/core/in-memory-session-store.test.ts \
  src/core/operations/claim.test.ts \
  src/local/sqlite-goal-session-store.test.ts \
  src/local/sqlite-store.test.ts \
  src/nexus/nexus-session-store.test.ts \
  src/nexus/nexus-claim-store.test.ts \
  src/server/routes/sessions.test.ts \
  src/mcp/tools/session.test.ts \
  src/cli/main.integration.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Run Biome check**

```bash
bun run check
```

Expected: exit 0.

- [ ] **Step 4: Run full test suite**

```bash
bun test
```

Expected: exit 0.

- [ ] **Step 5: Inspect diff**

```bash
git diff --stat HEAD
git diff --check
```

Expected: no whitespace errors. Diff should only include files listed in this plan plus any small helper files discovered during implementation, such as `src/nexus/lru-cache.ts` if Nexus claim deletion needs cache eviction.

- [ ] **Step 6: Final commit if verification fixes changed files**

If Step 1-5 required follow-up edits:

```bash
git add <changed-files>
git commit -m "fix: complete session delete finalizer integration"
```

If Step 1-5 required no follow-up edits, do not create an empty commit.

## Self-Review Notes

- Spec coverage: owner refs are covered in Tasks 1, 3, 4, and 5; finalizers and blockers in Tasks 2, 4, 5, and 6; force delete warning/audit in Tasks 2, 4, 5, 6, and 7; contribution manifest non-change is preserved by storing ownership in session links only.
- Type consistency: the plan uses `OwnerRef`, `Finalizer`, `SessionDeleteOptions`, `SessionDeleteBlocker`, and `SessionDeleteResult` consistently across core, stores, routes, MCP, and CLI.
- Risk: Nexus deletion is multi-file and not atomic. The plan requires idempotent persisted state and retry-safe cleanup rather than pretending cross-file atomicity exists.
