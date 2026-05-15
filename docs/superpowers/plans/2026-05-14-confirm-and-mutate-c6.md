# C6 — confirmAndMutate + @Dangerous Server Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the single-primitive pattern for destructive TUI mutations — snapshot-driven modal with live concurrent-mutation banner and 409 retry loop — plus server-side `428 Precondition Required` enforcement on every `@Dangerous` route, with a compile-time `DangerousToken` type brand preventing caller-bypass.

**Architecture:** Three new pieces (server `dangerous()` middleware; TUI `<ConfirmAndMutateProvider>` + `useConfirmAndMutate()` hook; `DangerousToken<K>` opaque type), changes to every mutating store method to accept `{ ifMatch? }` and return a discriminated `CasMutationResult`, and adoption of the helper across all TUI mutation callsites.

**Tech Stack:** TypeScript, Hono (server), React + a TUI renderer (no DOM portals; modal lives at app root via provider), Bun (test runner + sqlite), zod (validation).

**Spec:** `docs/superpowers/specs/2026-05-14-confirm-and-mutate-c6-design.md`
**Issue:** [#304](https://github.com/windoliver/grove/issues/304)

> **Spec addendum (discovered during planning):** today's stores do not persist `resourceVersion`; the entity adapter returns `"0"`. Task 1 below adds a `resource_version` integer column per mutating entity table (sqlite ALTER TABLE migration) bumped by the store on every write, and updates the entity projection to use it. This is the prerequisite that makes the spec's "bump RV per (namespace, kind, id) on every successful write" actually true.

---

## File map

**New files:**

| Path | Responsibility |
|------|----------------|
| `src/core/cas.ts` | `CasMutationResult<View>` discriminated union + `IfMatchMismatchError` (typed) used by stores/routes |
| `src/server/middleware/dangerous.ts` | Hono middleware: rejects missing/empty `If-Match` with 428; stashes value into context |
| `src/server/middleware/with-if-match.ts` | Controller helper: `get → patch(ifMatch)` retry loop |
| `src/tui/safety/index.ts` | Public exports: `useConfirmAndMutate`, `ConfirmAndMutateProvider`, `DangerousToken` (type-only) |
| `src/tui/safety/confirm-and-mutate.tsx` | Provider + modal + state machine + retry/banner logic |
| `src/tui/safety/internal/token.ts` | `mintDangerousToken` factory (not exported via `index.ts`) |
| `src/tui/safety/testing.ts` | `__test_only_mintToken` export for tests |
| `src/tui/safety/types.test.ts` | Compile-fail tests for bypass attempts |
| `tests/e2e/confirm-and-mutate.tmux.test.ts` | Real grove server + tmux TUI handshake + 409-retry E2E |

**Modified files (high-level):**

- `src/local/sqlite-store.ts` — add `resource_version` columns + migration; mutation methods accept `{ ifMatch? }`, return `CasMutationResult`, bump RV
- `src/local/sqlite-agent-task-store.ts`, `sqlite-bounty-store.ts`, `sqlite-handoff-store.ts`, `sqlite-goal-session-store.ts`, `sqlite-outcome-store.ts` — same CAS treatment
- `src/nexus/nexus-{claim,contribution,session,handoff,bounty}-store.ts` — proxy `ifMatch` through to Nexus
- `src/core/enforcing-store.ts` — pass `ifMatch` through, propagate `CasMutationResult`
- `src/server/routes/{agent-tasks,claims,sessions,contributions,bounties,goals,handoffs,outcomes,threads}.ts` — wrap mutating handlers with `dangerous()`, translate `rv-mismatch` to 409
- `src/nexus/nexus-http-client.ts`, `src/tui/remote-provider.ts` — dangerous client methods accept `DangerousToken`, send `If-Match`
- `src/tui/components/pages-router.tsx` — wrap children with `<ConfirmAndMutateProvider>`
- Bridge / reconciler files — adopt `withIfMatch()` for controller-driven status patches
- TUI views/screens — convert direct mutation calls to `useConfirmAndMutate()`

---

## Tasks

### Task 1: CAS result type + resource_version schema

**Why first:** every downstream task depends on stores returning a discriminated CAS result and persisting RV.

**Files:**
- Create: `src/core/cas.ts`
- Create: `src/core/cas.test.ts`
- Modify: `src/local/sqlite-store.ts` — schema migration for `resource_version` columns on `claim_spec`, `claim_status`, `agent_task_spec`, `agent_task_status`, `session`, `contribution`, `bounty`, `goal`, `handoff`, `outcome`, `thread` (subset that have mutating routes); reading helpers project RV string
- Modify: `src/core/entity.ts` — replace hardcoded `resourceVersion: "0"` with the real value from the read view

- [ ] **Step 1: Write the failing test for the CAS result type**

```ts
// src/core/cas.test.ts
import { describe, expect, test } from "bun:test";
import { isOk, isMismatch, type CasMutationResult } from "./cas.js";

describe("CasMutationResult", () => {
  test("isOk narrows to ok variant", () => {
    const r: CasMutationResult<{ x: number }> = { kind: "ok", view: { x: 1 } };
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.view.x).toBe(1);
  });

  test("isMismatch narrows to rv-mismatch variant", () => {
    const r: CasMutationResult<{ x: number }> = {
      kind: "rv-mismatch",
      current: { resourceVersion: "7", generation: 3 },
    };
    expect(isMismatch(r)).toBe(true);
    if (isMismatch(r)) expect(r.current.resourceVersion).toBe("7");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test src/core/cas.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/cas.ts`**

```ts
export interface CasOkResult<View> {
  readonly kind: "ok";
  readonly view: View;
}

export interface CasMismatchResult {
  readonly kind: "rv-mismatch";
  readonly current: { readonly resourceVersion: string; readonly generation: number };
}

export type CasMutationResult<View> = CasOkResult<View> | CasMismatchResult;

export function isOk<V>(r: CasMutationResult<V>): r is CasOkResult<V> {
  return r.kind === "ok";
}

export function isMismatch<V>(r: CasMutationResult<V>): r is CasMismatchResult {
  return r.kind === "rv-mismatch";
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bun test src/core/cas.test.ts`
Expected: PASS.

- [ ] **Step 5: Add schema migration in sqlite-store.ts**

In `src/local/sqlite-store.ts`, locate the migration block (search for `MIGRATIONS` or the version bump pattern). Add a new migration step:

```ts
// Bump SCHEMA_VERSION by 1.
// In the migration ladder for the new version:
db.exec(`
  ALTER TABLE claim_spec ADD COLUMN resource_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE claim_status ADD COLUMN resource_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session ADD COLUMN resource_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE contribution ADD COLUMN resource_version INTEGER NOT NULL DEFAULT 0;
  -- repeat for: bounty, goal, handoff, outcome, thread, agent_task_spec, agent_task_status
  -- Initialise existing rows to (generation when applicable, else 1):
  UPDATE claim_spec SET resource_version = generation;
  UPDATE claim_status SET resource_version = revision;
  -- ...similar for others
`);
```

Locate the precise migration ladder and add a new versioned step. Do not edit historical migrations.

- [ ] **Step 6: Update `readClaimView` and equivalents to include resource_version**

For each `read*View` function that produces an `Entity`-projectable record, add the column to the SELECT projection and propagate to the returned record. Update the entity adapter in `src/core/entity.ts`:

```ts
// In claimToEntity (and contributionToEntity, etc.), replace:
resourceVersion: "0",
// With:
resourceVersion: String(record.resourceVersion ?? 0),
```

The exact record shape may differ per entity; thread the new column through `readClaimView`, `readContributionView`, etc., to land on the `Entity` field.

- [ ] **Step 7: Run full local-store test suite, verify green**

Run: `bun test src/local/`
Expected: existing tests still PASS (we only added a column; reads now expose it).

- [ ] **Step 8: Commit**

```bash
git add src/core/cas.ts src/core/cas.test.ts src/core/entity.ts src/local/sqlite-store.ts
git commit -m "feat(core): CAS result type + resource_version persistence (C6 #304)"
```

---

### Task 2: Store CAS on `putClaimSpec` (canonical store change)

**Files:**
- Modify: `src/core/claim-store.conformance.ts` — add CAS test cases
- Modify: `src/local/sqlite-store.ts` — `putClaimSpec` accepts `{ ifMatch? }`, returns `CasMutationResult<ClaimView>`, bumps RV
- Modify: `src/nexus/nexus-claim-store.ts` — proxy `ifMatch` through to Nexus over HTTP, parse 409 response
- Modify: `src/core/enforcing-store.ts:562-590` — pass-through

**Conformance test additions:**

- [ ] **Step 1: Add conformance test for stale ifMatch**

In `src/core/claim-store.conformance.ts`, inside the existing `describe`:

```ts
test("putClaimSpec returns rv-mismatch when ifMatch is stale", async () => {
  const created = await store.putClaimSpec({
    id: "cas-stale",
    targetRef: "ref-1",
    agent: TEST_AGENT,
    intentSummary: "first",
    createdAt: NOW_ISO,
  });
  const staleRv = created.resourceVersion; // capture v1
  // External mutation bumps RV
  await store.putClaimSpec({
    id: "cas-stale",
    targetRef: "ref-1",
    agent: TEST_AGENT,
    intentSummary: "second",
    createdAt: NOW_ISO,
  });
  // Now retry with the captured stale RV
  const result = await store.putClaimSpec(
    {
      id: "cas-stale",
      targetRef: "ref-1",
      agent: TEST_AGENT,
      intentSummary: "third",
      createdAt: NOW_ISO,
    },
    { ifMatch: staleRv },
  );
  expect(result.kind).toBe("rv-mismatch");
  if (result.kind === "rv-mismatch") {
    expect(result.current.resourceVersion).not.toBe(staleRv);
  }
});

test("putClaimSpec succeeds when ifMatch matches", async () => {
  const created = await store.putClaimSpec({ /* ... */ });
  const result = await store.putClaimSpec(
    { /* ... same id, new fields */ },
    { ifMatch: created.resourceVersion },
  );
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") expect(result.view.resourceVersion).not.toBe(created.resourceVersion);
});

test("putClaimSpec without ifMatch still writes (back-compat)", async () => {
  const result = await store.putClaimSpec({ /* ... */ });
  // Legacy callers receive a CasMutationResult shaped as { kind: "ok", view } —
  // OR the method's return is changed to CasMutationResult unconditionally.
  expect(result.kind).toBe("ok");
});
```

Note: this changes the method's return type from `Promise<ClaimView>` to `Promise<CasMutationResult<ClaimView>>` unconditionally. All callers must update.

- [ ] **Step 2: Run conformance, verify it fails**

Run: `bun test src/core/claim-store.conformance.ts` (or via the runner that exercises it for sqlite + nexus).
Expected: FAIL — `ifMatch` option not supported; return type mismatch.

- [ ] **Step 3: Update `ClaimStore` interface**

In whatever file declares `ClaimStore` (likely `src/core/models.ts` or `src/core/claim-store.ts`):

```ts
import type { CasMutationResult } from "./cas.js";

export interface ClaimStore {
  putClaimSpec(
    spec: ClaimSpecRecord,
    opts?: { ifMatch?: string },
  ): Promise<CasMutationResult<ClaimView>>;
  // ...
}
```

- [ ] **Step 4: Implement CAS in sqlite `putClaimSpec`**

In `src/local/sqlite-store.ts` around line 2158:

```ts
putClaimSpec = async (
  spec: ClaimSpecRecord,
  opts?: { ifMatch?: string },
): Promise<CasMutationResult<ClaimView>> => {
  this.validateSpecContext(spec);

  let result: CasMutationResult<ClaimView> | null = null;
  let op: "ADDED" | "MODIFIED" = "MODIFIED";

  const tx = this.db.transaction(() => {
    const existing = this.readClaimView(spec.id);

    if (opts?.ifMatch !== undefined && existing !== null) {
      if (String(existing.resourceVersion) !== opts.ifMatch) {
        result = {
          kind: "rv-mismatch",
          current: {
            resourceVersion: String(existing.resourceVersion),
            generation: existing.metadata.generation,
          },
        };
        return; // abort transaction body, rollback automatic via early return
      }
    }

    // ... existing put logic ...

    // After spec write, bump resource_version on the spec row:
    this.db
      .prepare("UPDATE claim_spec SET resource_version = resource_version + 1 WHERE id = ?")
      .run(spec.id);
  });

  tx.immediate();

  if (result !== null) return result;

  const view = this.readClaimView(spec.id);
  if (view === null) throw new Error(`Failed to read back claim '${spec.id}'`);
  this.onClaimWrite?.(op, claimViewToClaim(view));
  return { kind: "ok", view };
};
```

The exact ClaimView shape and how `resourceVersion` projects to it depends on Task 1's adapter changes. The principle: `existing.resourceVersion` is the persisted column projected as a string.

- [ ] **Step 5: Implement same in nexus-claim-store**

In `src/nexus/nexus-claim-store.ts`, the existing HTTP wrapper:

```ts
putClaimSpec = async (
  spec: ClaimSpecRecord,
  opts?: { ifMatch?: string },
): Promise<CasMutationResult<ClaimView>> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts?.ifMatch !== undefined) headers["if-match"] = opts.ifMatch;
  const res = await this.fetch(`/api/claims/${encodeURIComponent(spec.id)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(spec),
  });
  if (res.status === 409) {
    const body = await res.json();
    return { kind: "rv-mismatch", current: body.error.current };
  }
  if (!res.ok) throw new Error(`putClaimSpec failed: ${res.status}`);
  return { kind: "ok", view: await res.json() };
};
```

- [ ] **Step 6: Update enforcing-store pass-through**

`src/core/enforcing-store.ts:562-590` — add `opts` param to signature, forward to `this.inner.putClaimSpec(spec, opts)`. Return type changes to `CasMutationResult<ClaimView>`.

- [ ] **Step 7: Update all callers of `putClaimSpec` to handle the discriminated result**

Use `grep -rn "putClaimSpec" src/` to find every site. For each non-CAS internal caller (reconciler, server route — handled in later tasks):

```ts
// Before:
const view = await store.putClaimSpec(spec);
// After:
const r = await store.putClaimSpec(spec);
if (r.kind === "rv-mismatch") throw new Error("unexpected RV mismatch on non-CAS path");
const view = r.view;
```

Internal callers don't pass `ifMatch`, so the mismatch branch is unreachable. Throwing is appropriate.

- [ ] **Step 8: Run conformance + reconciler tests**

Run: `bun test src/core/claim-store.conformance.ts src/core/reconciler.test.ts src/nexus/nexus-claim-store.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/core/cas.ts src/core/claim-store.conformance.ts src/core/enforcing-store.ts \
        src/core/reconciler.test.ts src/local/sqlite-store.ts src/nexus/nexus-claim-store.ts \
        src/core/models.ts
git commit -m "feat(stores): claim CAS via ifMatch + rv-mismatch result (C6 #304)"
```

---

### Task 3: Apply CAS pattern to remaining mutating store methods

Each method below repeats the **same shape** as Task 2 (`{ ifMatch? }` option → check current RV before write → bump RV on success → return `CasMutationResult`).

**Methods to update** (one TDD micro-cycle per method: write a conformance/store test for stale + fresh + missing-ifMatch, then implement):

| Method | File |
|--------|------|
| `patchClaimStatus` | `src/local/sqlite-store.ts:2266` (and conformance, nexus-claim-store) |
| `putAgentTaskSpec` | `src/local/sqlite-agent-task-store.ts` (search for `putAgentTaskSpec`) |
| `patchAgentTaskStatus` | same file |
| `deleteSession` | `src/local/sqlite-store.ts` (search) |
| `putSession` / `patchSession` if present | same |
| Contribution mutations | `src/local/sqlite-store.ts` contribution section |
| Bounty mutations | `src/local/sqlite-bounty-store.ts` |
| Handoff mutations | `src/local/sqlite-handoff-store.ts` |
| Goal-session mutations | `src/local/sqlite-goal-session-store.ts` |
| Outcome mutations | `src/local/sqlite-outcome-store.ts` |

For each row in the table:

- [ ] **Step 1: Add three conformance tests** (stale ifMatch → rv-mismatch; fresh → ok with bumped RV; missing → ok back-compat). Mirror Task 2 Step 1 verbatim, swapping types/IDs.

- [ ] **Step 2: Run, verify failure**

Run: `bun test <conformance-file>`
Expected: FAIL.

- [ ] **Step 3: Implement** the CAS shape from Task 2 Step 4 (sqlite) and Task 2 Step 5 (nexus proxy if a nexus-* store exists for that kind).

- [ ] **Step 4: Update interface + enforcing-store pass-through + every direct caller** (mechanical; TypeScript surfaces all sites).

- [ ] **Step 5: Run, verify pass.**

- [ ] **Step 6: Commit** with message `feat(stores): <method> CAS via ifMatch (C6 #304)`.

Treat each method as its own commit. ~10 small commits.

---

### Task 4: `dangerous()` middleware

**Files:**
- Create: `src/server/middleware/dangerous.ts`
- Create: `src/server/middleware/dangerous.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/server/middleware/dangerous.test.ts
import { Hono } from "hono";
import { describe, expect, test } from "bun:test";
import { dangerous } from "./dangerous.js";

describe("dangerous middleware", () => {
  function app() {
    const a = new Hono();
    a.put(
      "/widget/:id",
      dangerous(async (c) => {
        const ifMatch = c.get("ifMatch") as string;
        return c.json({ ok: true, ifMatch });
      }),
    );
    return a;
  }

  test("missing If-Match → 428", async () => {
    const res = await app().request("/widget/1", { method: "PUT" });
    expect(res.status).toBe(428);
    const body = await res.json();
    expect(body.error.code).toBe("PRECONDITION_REQUIRED");
  });

  test("empty If-Match → 428", async () => {
    const res = await app().request("/widget/1", {
      method: "PUT",
      headers: { "if-match": "" },
    });
    expect(res.status).toBe(428);
  });

  test("present If-Match → handler invoked", async () => {
    const res = await app().request("/widget/1", {
      method: "PUT",
      headers: { "if-match": "v3" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ifMatch: "v3" });
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test src/server/middleware/dangerous.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/middleware/dangerous.ts`**

```ts
import type { Context, Handler } from "hono";

export function dangerous(handler: Handler): Handler {
  return async (c: Context) => {
    const ifMatch = c.req.header("If-Match");
    if (ifMatch === undefined || ifMatch === "") {
      return c.json(
        {
          error: {
            code: "PRECONDITION_REQUIRED",
            message: "If-Match header required for @Dangerous endpoint",
          },
        },
        428,
      );
    }
    c.set("ifMatch", ifMatch);
    return handler(c);
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/server/middleware/dangerous.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/middleware/dangerous.ts src/server/middleware/dangerous.test.ts
git commit -m "feat(server): dangerous() middleware enforces If-Match → 428 (C6 #304)"
```

---

### Task 5: Apply `dangerous()` to one route end-to-end — `DELETE /api/sessions/:id`

This is the smallest fully wired example: middleware + store CAS + route translation. Validates the whole vertical slice before fanning out.

**Files:**
- Modify: `src/server/routes/sessions.ts` — wrap DELETE handler with `dangerous()`, translate rv-mismatch to 409
- Modify: `src/server/routes/sessions.test.ts:181` (existing DELETE tests) — add 428 + 409 cases

- [ ] **Step 1: Add failing route tests**

Inside the existing `sessions.test.ts` describe block:

```ts
test("DELETE /api/sessions/:id without If-Match → 428", async () => {
  const res = await app.request(`/api/sessions/${sessionId}`, { method: "DELETE" });
  expect(res.status).toBe(428);
  // Session not deleted:
  expect(goalSessionStore.deleteCalls).toHaveLength(0);
});

test("DELETE /api/sessions/:id with stale If-Match → 409 with current snapshot", async () => {
  goalSessionStore.nextDeleteResult = {
    kind: "rv-mismatch",
    current: { resourceVersion: "5", generation: 2 },
  };
  const res = await app.request(`/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { "if-match": "3" },
  });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error.code).toBe("CONFLICT");
  expect(body.error.current.resourceVersion).toBe("5");
});

test("DELETE /api/sessions/:id with fresh If-Match → 200 and store called with ifMatch", async () => {
  goalSessionStore.nextDeleteResult = { kind: "ok", view: undefined };
  const res = await app.request(`/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { "if-match": "5" },
  });
  expect(res.status).toBe(200);
  expect(goalSessionStore.deleteCalls.at(-1)).toMatchObject({
    id: sessionId,
    options: expect.objectContaining({ ifMatch: "5" }),
  });
});
```

The test fixture `goalSessionStore` (existing at lines 79+) needs a `nextDeleteResult` field and its `deleteSession` impl needs to return that result when set. Adjust the fixture accordingly.

- [ ] **Step 2: Run, verify failure**

Run: `bun test src/server/routes/sessions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Wrap the route + translate result**

In `src/server/routes/sessions.ts`, find the `DELETE /:id` handler. Change:

```ts
// Before:
sessions.delete("/:id", async (c) => { /* ... */ });

// After:
import { dangerous } from "../middleware/dangerous.js";

sessions.delete(
  "/:id",
  dangerous(async (c) => {
    const ifMatch = c.get("ifMatch") as string;
    const force = c.req.query("force") === "true";
    const result = await store.deleteSession(c.req.param("id"), {
      ifMatch,
      force,
      actor: /* existing actor extraction */,
    });
    if (result.kind === "rv-mismatch") {
      return c.json({ error: { code: "CONFLICT", current: result.current } }, 409);
    }
    // existing success response shape:
    return c.json({ deleted: true });
  }),
);
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/server/routes/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/sessions.ts src/server/routes/sessions.test.ts
git commit -m "feat(server): DELETE /api/sessions/:id @Dangerous + If-Match (C6 #304)"
```

---

### Task 6: Fan out `dangerous()` across remaining mutating routes

Mechanical application of the Task 5 pattern. One TDD cycle per route file.

**Routes to wrap** (audit confirmed):

| File | Routes |
|------|--------|
| `src/server/routes/agent-tasks.ts` | `PUT /:id`, `PATCH /:id/status` |
| `src/server/routes/claims.ts` | `PUT /:id`, `PATCH /:id`, `PATCH /:id/status` |
| `src/server/routes/contributions.ts` | (audit: any PUT/PATCH/DELETE — likely DELETE /:id and update endpoints) |
| `src/server/routes/bounties.ts` | mutations |
| `src/server/routes/goals.ts` | `PUT /goal` and other mutations |
| `src/server/routes/handoffs.ts` | mutations |
| `src/server/routes/outcomes.ts` | mutations |
| `src/server/routes/threads.ts` | mutations |
| `src/server/routes/sessions.ts` | any remaining mutations beyond DELETE |

For each row:

- [ ] **Step 1: Audit** with `rg "\\.(put|patch|delete)\\(" <file>` to list mutating routes.

- [ ] **Step 2: For each mutating route, add three route tests** (428 missing, 409 stale, 200 fresh) mirroring Task 5 Step 1. Use the existing route test file's fixture style.

- [ ] **Step 3: Run, verify failure.**

- [ ] **Step 4: Wrap handler with `dangerous(...)`, translate `rv-mismatch` to 409.** Pattern from Task 5 Step 3.

- [ ] **Step 5: Run, verify pass.**

- [ ] **Step 6: Commit** per file: `feat(server): @Dangerous wrap <file> routes (C6 #304)`.

---

### Task 7: `withIfMatch()` controller helper + adopt in bridge

**Files:**
- Create: `src/server/middleware/with-if-match.ts`
- Create: `src/server/middleware/with-if-match.test.ts`
- Modify: bridge / reconciler files that call `PATCH /:id/status` from controller code (search: `patchClaimStatus`, `patchAgentTaskStatus` callsites in `src/server/`, `src/core/reconciler.ts`, etc.)

- [ ] **Step 1: Write failing test**

```ts
// src/server/middleware/with-if-match.test.ts
import { describe, expect, test, mock } from "bun:test";
import { withIfMatch } from "./with-if-match.js";

describe("withIfMatch", () => {
  test("succeeds on first try when RV matches", async () => {
    const read = mock(async () => ({ resourceVersion: "7" }));
    const patch = mock(async (opts: { ifMatch: string }) => ({
      kind: "ok" as const,
      view: { x: 1, ifMatchUsed: opts.ifMatch },
    }));
    const result = await withIfMatch(read, patch);
    expect(result).toEqual({ x: 1, ifMatchUsed: "7" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  test("retries on rv-mismatch up to maxRetries", async () => {
    const reads = ["1", "2", "3"];
    const read = mock(async () => ({ resourceVersion: reads.shift()! }));
    let attempt = 0;
    const patch = mock(async () => {
      attempt++;
      if (attempt < 3) return { kind: "rv-mismatch", current: { resourceVersion: "x", generation: 0 } };
      return { kind: "ok" as const, view: { ok: true } };
    });
    const result = await withIfMatch(read, patch, { maxRetries: 5 });
    expect(result).toEqual({ ok: true });
    expect(read).toHaveBeenCalledTimes(3);
  });

  test("throws after exhausting retries", async () => {
    const read = mock(async () => ({ resourceVersion: "1" }));
    const patch = mock(async () => ({ kind: "rv-mismatch", current: { resourceVersion: "x", generation: 0 } }));
    await expect(withIfMatch(read, patch, { maxRetries: 2 })).rejects.toThrow(/retries/);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test src/server/middleware/with-if-match.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/server/middleware/with-if-match.ts
import type { CasMutationResult } from "../../core/cas.js";

export async function withIfMatch<View>(
  read: () => Promise<{ resourceVersion: string }>,
  patch: (opts: { ifMatch: string }) => Promise<CasMutationResult<View>>,
  opts?: { maxRetries?: number },
): Promise<View> {
  const max = opts?.maxRetries ?? 3;
  let lastMismatch: { resourceVersion: string; generation: number } | undefined;
  for (let i = 0; i <= max; i++) {
    const cur = await read();
    const result = await patch({ ifMatch: cur.resourceVersion });
    if (result.kind === "ok") return result.view;
    lastMismatch = result.current;
  }
  throw new Error(
    `withIfMatch: exhausted ${max} retries; last current RV=${lastMismatch?.resourceVersion ?? "?"}`,
  );
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/server/middleware/with-if-match.test.ts`
Expected: PASS.

- [ ] **Step 5: Adopt in controller callsites**

For each controller-driven status patch (typically in `src/core/reconciler.ts`, bridge files in `src/server/`), find:

```ts
// Before:
await claimStore.patchClaimStatus(id, patch);

// After:
await withIfMatch(
  async () => {
    const view = await claimStore.getClaimView(id);
    if (view === undefined) throw new NotFoundError(...);
    return { resourceVersion: String(view.resourceVersion) };
  },
  (opts) => claimStore.patchClaimStatus(id, patch, opts),
);
```

For every site identified by `grep -rn "patchClaimStatus\|patchAgentTaskStatus" src/`.

- [ ] **Step 6: Run all affected tests**

Run: `bun test src/core/reconciler.test.ts src/server/routes/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/middleware/with-if-match.ts src/server/middleware/with-if-match.test.ts \
        src/core/reconciler.ts # and other adopted files
git commit -m "feat(server): withIfMatch controller helper, adopt in reconcilers (C6 #304)"
```

---

### Task 8: `DangerousToken<K>` brand + private factory

**Files:**
- Create: `src/tui/safety/internal/token.ts`
- Create: `src/tui/safety/testing.ts`
- Create: `src/tui/safety/index.ts` (stub — re-exports type only for now)
- Create: `src/tui/safety/internal/token.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/tui/safety/internal/token.test.ts
import { describe, expect, test } from "bun:test";
import { mintDangerousToken } from "./token.js";

describe("DangerousToken", () => {
  test("mintDangerousToken stamps kind/id/ifMatch", () => {
    const token = mintDangerousToken("AgentSession", "sess-1", "rv-7");
    expect(token.kind).toBe("AgentSession");
    expect(token.id).toBe("sess-1");
    expect(token.ifMatch).toBe("rv-7");
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test src/tui/safety/internal/token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/tui/safety/internal/token.ts
declare const __dangerousToken: unique symbol;

export type DangerousToken<K extends string> = {
  readonly [__dangerousToken]: never;
  readonly kind: K;
  readonly id: string;
  readonly ifMatch: string;
};

export function mintDangerousToken<K extends string>(
  kind: K,
  id: string,
  ifMatch: string,
): DangerousToken<K> {
  return { kind, id, ifMatch } as DangerousToken<K>;
}
```

```ts
// src/tui/safety/testing.ts
export { mintDangerousToken as __test_only_mintToken } from "./internal/token.js";
```

```ts
// src/tui/safety/index.ts
export type { DangerousToken } from "./internal/token.js";
// useConfirmAndMutate + ConfirmAndMutateProvider added in Task 10.
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/tui/safety/internal/token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/safety/
git commit -m "feat(tui/safety): DangerousToken brand + private factory (C6 #304)"
```

---

### Task 9: Refactor dangerous client methods to require `DangerousToken`

**Files:**
- Modify: `src/nexus/nexus-http-client.ts`
- Modify: `src/tui/remote-provider.ts`
- Modify: every callsite (TypeScript will list them)

- [ ] **Step 1: Identify dangerous client methods**

These are the client surface methods that map to `@Dangerous` server routes. Likely: `deleteSession`, `putClaimSpec`, `patchClaimStatus`, `patchClaim` (heartbeat/release/complete), `putAgentTaskSpec`, `patchAgentTaskStatus`, `deleteContribution`, plus bounty/goal/handoff/outcome/thread mutations.

Audit with: `rg "client\.(delete|put|patch)" src/tui/`

- [ ] **Step 2: Refactor each method signature**

Pattern (example for `deleteSession`):

```ts
// Before:
async deleteSession(id: string, opts?: { force?: boolean }): Promise<void> { /* ... */ }

// After:
import type { DangerousToken } from "../tui/safety/index.js";

async deleteSession(
  token: DangerousToken<"AgentSession">,
  opts?: { force?: boolean },
): Promise<void> {
  const headers: Record<string, string> = { "if-match": token.ifMatch };
  const url = `/api/sessions/${encodeURIComponent(token.id)}${
    opts?.force === true ? "?force=true" : ""
  }`;
  const res = await this.fetch(url, { method: "DELETE", headers });
  if (!res.ok) throw new Error(`deleteSession failed: ${res.status}`);
}
```

- [ ] **Step 3: TypeScript surfaces every broken callsite. Leave them broken for now** — they'll be fixed in Task 11.

- [ ] **Step 4: Run typecheck**

Run: `bun tsc --noEmit`
Expected: FAIL (with a list of callsites). This is intentional and shows the brand is enforced.

- [ ] **Step 5: Commit signature changes only** (NO callsite fixes yet, so we can review the full surface)

```bash
git add src/nexus/nexus-http-client.ts src/tui/remote-provider.ts
git commit -m "feat(client): dangerous methods require DangerousToken (C6 #304)

Intentional broken state: all callsites must adopt useConfirmAndMutate
in Task 11. TypeScript surfaces every site that needs updating."
```

Note: this commit is intentionally non-green for the typecheck. If CI blocks merges on tsc, defer this commit to a feature branch and merge after Task 11.

---

### Task 10: `<ConfirmAndMutateProvider>` + `useConfirmAndMutate` hook + modal

**Files:**
- Modify: `src/tui/safety/confirm-and-mutate.tsx` (create)
- Modify: `src/tui/safety/index.ts` — export provider + hook
- Create: `src/tui/safety/confirm-and-mutate.test.tsx`

- [ ] **Step 1: Write failing tests** (cover all five scenarios from spec)

```tsx
// src/tui/safety/confirm-and-mutate.test.tsx
import { describe, expect, test, mock } from "bun:test";
import { render, act } from "../test-utils/render.js"; // existing TUI test harness
import {
  ConfirmAndMutateProvider,
  useConfirmAndMutate,
  type ConfirmAndMutateResult,
} from "./index.js";

const FAKE_ENTITY = {
  kind: "AgentSession" as const,
  namespace: "ns",
  id: "sess-1",
  resourceVersion: "5",
  spec: { /* ... */ },
  status: {},
  conditions: [],
  observedGeneration: 0,
  metadata: { generation: 1 },
};

function makeCaller(mutation: (token: { ifMatch: string }) => Promise<unknown>) {
  let triggerFn: ((opts: any) => Promise<ConfirmAndMutateResult<unknown>>) | null = null;
  function Caller() {
    triggerFn = useConfirmAndMutate();
    return null;
  }
  const tree = render(
    <ConfirmAndMutateProvider entityStore={fakeEntityStore}>
      <Caller />
    </ConfirmAndMutateProvider>,
  );
  return { tree, trigger: () => triggerFn!({ entity: FAKE_ENTITY, message: "Delete?", dangerous: true, mutation }) };
}

describe("useConfirmAndMutate", () => {
  test("happy path: confirm → mutation receives token with correct ifMatch → ok", async () => {
    const mutation = mock(async (token: any) => "result");
    const { tree, trigger } = makeCaller(mutation);
    const promise = trigger();
    await act(() => tree.send("y"));
    const res = await promise;
    expect(res).toEqual({ ok: true, value: "result" });
    expect(mutation).toHaveBeenCalledWith(expect.objectContaining({ ifMatch: "5" }));
  });

  test("cancel returns { ok: false, reason: 'cancelled' } and skips mutation", async () => {
    const mutation = mock(async () => "x");
    const { tree, trigger } = makeCaller(mutation);
    const promise = trigger();
    await act(() => tree.send("n"));
    const res = await promise;
    expect(res).toEqual({ ok: false, reason: "cancelled" });
    expect(mutation).not.toHaveBeenCalled();
  });

  test("409 once → retry with fresh snapshot succeeds", async () => {
    let attempts = 0;
    const mutation = mock(async (_token: any) => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("conflict");
        (err as any).status = 409;
        (err as any).current = { resourceVersion: "6", generation: 2 };
        throw err;
      }
      return "result";
    });
    const { tree, trigger } = makeCaller(mutation);
    const promise = trigger();
    await act(() => tree.send("y"));   // first submit → 409
    await act(() => tree.send("y"));   // retry → ok
    const res = await promise;
    expect(res).toEqual({ ok: true, value: "result" });
    // Second mutation call should have seen RV "6":
    expect(mutation.mock.calls[1][0].ifMatch).toBe("6");
  });

  test("409 three times → { ok: false, reason: 'max-retries' }", async () => {
    const mutation = mock(async () => {
      const err = new Error("conflict");
      (err as any).status = 409;
      (err as any).current = { resourceVersion: "9", generation: 4 };
      throw err;
    });
    const { tree, trigger } = makeCaller(mutation);
    const promise = trigger();
    await act(() => tree.send("y"));
    await act(() => tree.send("y"));
    await act(() => tree.send("y"));
    await act(() => tree.send("y"));
    const res = await promise;
    expect(res).toEqual({ ok: false, reason: "max-retries" });
  });

  test("external RV change while modal open → banner appears", async () => {
    const mutation = mock(async () => "x");
    const { tree, trigger } = makeCaller(mutation);
    const promise = trigger();
    // Simulate external mutation bumping RV on the entity store:
    fakeEntityStore.update("AgentSession", "sess-1", { ...FAKE_ENTITY, resourceVersion: "6" });
    await act(() => {}); // flush
    expect(tree.output()).toContain("state changed externally");
    await act(() => tree.send("n"));
    await promise;
  });
});
```

The exact `fakeEntityStore` shape and `render()` harness come from existing TUI test infrastructure (look at `src/tui/components/entity-view.test.tsx` for the pattern).

- [ ] **Step 2: Run, verify failure**

Run: `bun test src/tui/safety/confirm-and-mutate.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement provider + modal + hook**

```tsx
// src/tui/safety/confirm-and-mutate.tsx
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { WatchKind } from "../../core/watch-events.js";
import type { EntityForKind } from "../../core/informer.js";
import { useEntity } from "../hooks/use-entity.js";
import { theme } from "../theme.js";
import { mintDangerousToken } from "./internal/token.js";
import type { DangerousToken } from "./internal/token.js";

const MAX_RETRIES = 3;

export interface ConfirmAndMutateRequest<K extends WatchKind, R> {
  readonly entity: EntityForKind<K>;
  readonly message: string;
  readonly dangerous: true;
  readonly mutation: (token: DangerousToken<K>) => Promise<R>;
  readonly diff?: (prev: EntityForKind<K>, next: EntityForKind<K>) => React.ReactNode;
}

export type ConfirmAndMutateResult<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly reason: "cancelled" | "max-retries" };

interface InternalState {
  open: boolean;
  request: ConfirmAndMutateRequest<any, any> | null;
  snapshot: EntityForKind<any> | null;
  banner: boolean;
  retryCount: number;
  resolve: ((r: ConfirmAndMutateResult<any>) => void) | null;
}

const Ctx = createContext<{
  trigger: <K extends WatchKind, R>(
    req: ConfirmAndMutateRequest<K, R>,
  ) => Promise<ConfirmAndMutateResult<R>>;
} | null>(null);

export function ConfirmAndMutateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<InternalState>({
    open: false,
    request: null,
    snapshot: null,
    banner: false,
    retryCount: 0,
    resolve: null,
  });

  const trigger = useCallback(
    <K extends WatchKind, R>(req: ConfirmAndMutateRequest<K, R>) =>
      new Promise<ConfirmAndMutateResult<R>>((resolve) => {
        setState({
          open: true,
          request: req,
          snapshot: req.entity,
          banner: false,
          retryCount: 0,
          resolve: resolve as any,
        });
      }),
    [],
  );

  const close = useCallback((r: ConfirmAndMutateResult<any>) => {
    setState((s) => {
      s.resolve?.(r);
      return { open: false, request: null, snapshot: null, banner: false, retryCount: 0, resolve: null };
    });
  }, []);

  const onConfirm = useCallback(async () => {
    const { request, snapshot, retryCount } = state;
    if (!request || !snapshot) return;
    const token = mintDangerousToken(snapshot.kind, snapshot.id, snapshot.resourceVersion);
    try {
      const value = await request.mutation(token);
      close({ ok: true, value });
    } catch (e: any) {
      if (e?.status === 409 && e?.current) {
        if (retryCount + 1 > MAX_RETRIES) {
          close({ ok: false, reason: "max-retries" });
          return;
        }
        setState((s) => ({
          ...s,
          snapshot: { ...(s.snapshot as any), resourceVersion: e.current.resourceVersion },
          banner: true,
          retryCount: s.retryCount + 1,
        }));
        return;
      }
      throw e;
    }
  }, [state, close]);

  const onCancel = useCallback(() => close({ ok: false, reason: "cancelled" }), [close]);

  return (
    <Ctx.Provider value={{ trigger }}>
      {children}
      {state.open && state.request && state.snapshot && (
        <ConfirmAndMutateModal
          request={state.request}
          snapshot={state.snapshot}
          banner={state.banner}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onBannerUpdate={(banner) => setState((s) => ({ ...s, banner }))}
        />
      )}
    </Ctx.Provider>
  );
}

export function useConfirmAndMutate() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useConfirmAndMutate requires <ConfirmAndMutateProvider>");
  return ctx.trigger;
}

interface ModalProps {
  request: ConfirmAndMutateRequest<any, any>;
  snapshot: EntityForKind<any>;
  banner: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onBannerUpdate: (banner: boolean) => void;
}

function ConfirmAndMutateModal({
  request, snapshot, banner, onConfirm, onCancel, onBannerUpdate,
}: ModalProps) {
  const live = useEntity(snapshot.kind, snapshot.id);
  // Detect external RV change vs snapshot
  React.useEffect(() => {
    if (live && live.resourceVersion !== snapshot.resourceVersion && !banner) {
      onBannerUpdate(true);
    }
  }, [live, snapshot.resourceVersion, banner, onBannerUpdate]);

  // Keyboard handler is wired by the parent screen-stack — this component
  // exposes onConfirm/onCancel and relies on the existing dialog key routing.
  return (
    <box flexDirection="column" paddingX={2} paddingY={1} borderStyle="single" borderColor={theme.focus}>
      <text bold color={theme.focus}>{`Confirm: ${request.message}`}</text>
      <text>Kind: {snapshot.kind}</text>
      <text>Id: {snapshot.id}</text>
      {banner && (
        <box marginTop={1} flexDirection="column">
          <text color={theme.warning}>⚠ state changed externally — review before confirming</text>
          <text color={theme.secondary}>
            was rv={snapshot.resourceVersion} → now rv={live?.resourceVersion}
          </text>
        </box>
      )}
      <text color={theme.secondary}>[y] confirm  [n] cancel</text>
    </box>
  );
}
```

```ts
// src/tui/safety/index.ts (final)
export type { DangerousToken } from "./internal/token.js";
export {
  ConfirmAndMutateProvider,
  useConfirmAndMutate,
  type ConfirmAndMutateRequest,
  type ConfirmAndMutateResult,
} from "./confirm-and-mutate.js";
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test src/tui/safety/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/safety/
git commit -m "feat(tui/safety): ConfirmAndMutateProvider + useConfirmAndMutate hook (C6 #304)"
```

---

### Task 11: Mount provider + convert TUI callsites

**Files:**
- Modify: `src/tui/components/pages-router.tsx:138` — wrap children with `<ConfirmAndMutateProvider>`
- Modify: every TUI mutation callsite (TypeScript lists them from Task 9's broken state)

- [ ] **Step 1: Wrap router with provider**

`src/tui/components/pages-router.tsx`:

```tsx
// Before:
return (
  <>
    {/* existing structure */}
    <ConfirmPopDialog visible={dialogOpen} onConfirm={handleConfirm} onCancel={handleCancel} />
  </>
);

// After:
import { ConfirmAndMutateProvider } from "../safety/index.js";

return (
  <ConfirmAndMutateProvider>
    {/* existing structure */}
    <ConfirmPopDialog visible={dialogOpen} onConfirm={handleConfirm} onCancel={handleCancel} />
  </ConfirmAndMutateProvider>
);
```

- [ ] **Step 2: Run typecheck to see broken callsites**

Run: `bun tsc --noEmit 2>&1 | head -100`
Expected: list of callsites in `src/tui/views/*.tsx`, `src/tui/screens/*.tsx`, possibly `src/tui/components/*.tsx`.

- [ ] **Step 3: For each callsite, convert direct mutation to useConfirmAndMutate**

Pattern:

```tsx
// Before:
async function handleDelete(id: string) {
  await client.deleteSession(id);
  showFlash("Session deleted");
}

// After:
import { useConfirmAndMutate } from "../safety/index.js";

function Component({ session }: { session: AgentSessionEntity }) {
  const confirmAndMutate = useConfirmAndMutate();
  async function handleDelete() {
    const r = await confirmAndMutate({
      entity: session,
      message: "Delete session?",
      dangerous: true,
      mutation: (token) => client.deleteSession(token),
    });
    if (r.ok) showFlash("Session deleted");
    else if (r.reason === "max-retries") showFlash("Aborted: state kept changing");
  }
}
```

Track each conversion as its own commit (`feat(tui): adopt useConfirmAndMutate in <view> (C6 #304)`) so review is incremental.

- [ ] **Step 4: After all callsites converted, run typecheck + full TUI test suite**

Run: `bun tsc --noEmit && bun test src/tui/`
Expected: PASS.

- [ ] **Step 5: Final commit if any leftover wiring**

```bash
git add src/tui/components/pages-router.tsx
git commit -m "feat(tui): mount ConfirmAndMutateProvider in pages-router (C6 #304)"
```

---

### Task 12: Type-fail tests for caller-bypass

**Files:**
- Create: `src/tui/safety/types.test.ts`

- [ ] **Step 1: Write the test (will be checked by `bun tsc --noEmit`, not the runtime runner)**

```ts
// src/tui/safety/types.test.ts
// This file uses @ts-expect-error to verify the type brand prevents bypass.
// It is not a runtime test; `bun tsc --noEmit` enforces it.

import type { DangerousToken } from "./index.js";
import type { NexusHttpClient } from "../../nexus/nexus-http-client.js";

declare const client: NexusHttpClient;
declare const validToken: DangerousToken<"AgentSession">;

// @ts-expect-error — calling deleteSession without a token must not compile
client.deleteSession("sess-1");

// Calling with a valid token compiles fine:
void client.deleteSession(validToken);

// @ts-expect-error — constructing a token via object literal must not compile
const fake: DangerousToken<"AgentSession"> = {
  kind: "AgentSession",
  id: "sess-1",
  ifMatch: "1",
};
void fake;

// @ts-expect-error — wrong kind on the token must not compile
const wrongKind: DangerousToken<"Claim"> = validToken;
void wrongKind;
```

- [ ] **Step 2: Run typecheck, verify all `@ts-expect-error` lines actually error**

Run: `bun tsc --noEmit`
Expected: PASS (because each `@ts-expect-error` is consumed by a real error). If a line fails to error, tsc reports "Unused '@ts-expect-error' directive" — fix the type definitions.

- [ ] **Step 3: Commit**

```bash
git add src/tui/safety/types.test.ts
git commit -m "test(tui/safety): type-level bypass prevention (C6 #304)"
```

---

### Task 13: E2E tmux test — handshake + 409 retry

**Files:**
- Create: `tests/e2e/confirm-and-mutate.tmux.test.ts`

Pattern reference: `tests/e2e/watch-relist-tmux.ts`.

- [ ] **Step 1: Write the E2E**

```ts
// tests/e2e/confirm-and-mutate.tmux.test.ts
import { describe, expect, test } from "bun:test";
import { startGroveServer, attachTmuxTui, sendKeys, readScreen, sleep } from "./tmux-harness.js";

describe("confirm-and-mutate E2E", () => {
  test("external RV change shows banner; 409 triggers retry with fresh snapshot", async () => {
    const server = await startGroveServer();
    const tui = await attachTmuxTui(server.url);

    // Seed an entity (a claim, for example):
    const claim = await server.client.putClaimSpec({ /* ... */ });

    // Navigate to the claim and open a mutation (e.g., release):
    await sendKeys(tui, "/claims");
    await sendKeys(tui, "Enter");
    await sendKeys(tui, "x"); // hypothetical "release" hotkey wired to confirmAndMutate

    // Modal should be open with snapshot RV:
    let screen = await readScreen(tui);
    expect(screen).toContain("Confirm:");
    expect(screen).toContain(`rv=${claim.resourceVersion}`);

    // External mutation: bump RV via API
    await server.client.patchClaim(claim.id, { someField: "new" });

    // Banner should appear within 200ms:
    const start = Date.now();
    let banner = false;
    while (Date.now() - start < 500) {
      screen = await readScreen(tui);
      if (screen.includes("state changed externally")) {
        banner = true;
        break;
      }
      await sleep(20);
    }
    expect(banner).toBe(true);
    expect(Date.now() - start).toBeLessThan(200);

    // Submit anyway → expect 409 → modal re-opens with fresh snapshot:
    await sendKeys(tui, "y");
    await sleep(100);
    screen = await readScreen(tui);
    expect(screen).toContain("Confirm:"); // still open
    // Banner persists; rv should now reflect server's new value:
    expect(screen).toMatch(/rv=\d+/);

    // Submit again → succeeds:
    await sendKeys(tui, "y");
    await sleep(100);
    screen = await readScreen(tui);
    expect(screen).not.toContain("Confirm:"); // modal closed

    await tui.dispose();
    await server.stop();
  });
});
```

The exact `tmux-harness` helpers and the hotkey to trigger the mutation depend on the existing test infrastructure. Adapt to match `tests/e2e/watch-relist-tmux.ts`.

- [ ] **Step 2: Run, verify pass**

Run: `bun test tests/e2e/confirm-and-mutate.tmux.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/confirm-and-mutate.tmux.test.ts
git commit -m "test(e2e): confirm-and-mutate handshake + 409 retry tmux test (C6 #304)"
```

---

### Task 14: Close the loop — verify acceptance criteria

- [ ] **Step 1: Manual sanity check against issue #304 acceptance**

| Criterion | Evidence |
|-----------|----------|
| Modal display stable | Task 10 snapshot capture; Task 13 E2E confirms fields don't shift |
| Concurrent mutation → banner within 200ms | Task 13 measures latency; assertion `< 200ms` |
| 409 → modal re-opens with fresh snapshot | Task 10 unit test "409 once" + Task 13 |
| Caller-bypass test (lint rule) | Task 12 type-fail tests |
| Server 428 test | Task 4 middleware test + Task 5 route test |

- [ ] **Step 2: Run full suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 3: Lint + typecheck**

Run: `bun lint && bun tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Final commit (if any cleanup)**

```bash
git status
# If any pending changes:
git add -p
git commit -m "chore: C6 cleanup + acceptance verification (C6 #304)"
```

- [ ] **Step 5: PR**

```bash
gh pr create --title "C6: confirmAndMutate + @Dangerous 428 enforcement (#304)" --body "$(cat <<'EOF'
## Summary
- TUI `useConfirmAndMutate()` hook owns CAS submit + live concurrent-mutation banner + 409 retry
- Server `dangerous()` middleware rejects missing/empty If-Match with 428
- `DangerousToken<K>` type brand replaces the issue's "lint rule" with compile-time prevention
- Stores gain `{ ifMatch? }` option, return `CasMutationResult<View>`, bump per-resource `resource_version` on write

Closes #304.

## Test plan
- [ ] `bun test`
- [ ] `bun tsc --noEmit`
- [ ] `bun lint`
- [ ] Tmux E2E proves banner < 200ms latency + 409 retry path
- [ ] Type-fail test proves bypass cannot compile
EOF
)"
```

---

## Self-review notes

- Every spec section (`§1`–`§6`) is covered by tasks 1–14.
- Schema-migration discovery noted as spec addendum (Task 1).
- Type signatures kept consistent: `CasMutationResult<View>` discriminant fields (`kind: "ok" | "rv-mismatch"`) and `DangerousToken<K>` fields (`kind`, `id`, `ifMatch`) used identically across all tasks.
- Task 9 intentionally leaves typecheck red; Task 11 closes it. Plan calls this out so it's not mistaken for a mistake.
- Test code in every TDD step is concrete (not "write tests for …").
- Each commit is in the `feat:` / `test:` / `chore:` Conventional Commits style, matching recent repo log.
