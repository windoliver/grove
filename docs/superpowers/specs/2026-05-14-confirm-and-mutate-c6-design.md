# C6 — `confirmAndMutate` helper + `@Dangerous` 428 server enforcement

**Issue**: [#304](https://github.com/windoliver/grove/issues/304)
**Parent epic**: [#284](https://github.com/windoliver/grove/issues/284) — Epic C: TUI Views + Mutation Safety
**Depends on**: #292 (A5 watch protocol, MERGED), #297 (D1 spec/status split, MERGED), #287 (Entity envelope, prior)
**Reference**: Kubernetes `metav1.UpdateOptions` + `resourceVersion`; HTTP `If-Match` / 412 / 428 patterns; k8s API server's CAS write semantics.

## Goal

Make every destructive TUI mutation routed through a single primitive — `confirmAndMutate` — that owns the snapshot, the live concurrent-mutation banner, the CAS write, and the 409-driven retry. Eliminate the footgun where a caller could build the mutation themselves and forget the `If-Match` header. Add server-side defense-in-depth so any mutation request without `If-Match` on a `@Dangerous` endpoint is rejected with `428 Precondition Required`, independent of TUI compliance.

## Non-goals

- Non-dangerous mutations (idempotent POSTs, server-driven status reconciliation by trusted controllers using their own loops) are out of scope. Controllers may still use the CAS path, but they aren't required to route through `confirmAndMutate`.
- Server-side audit log / undo. CAS prevents *silent* overwrite; auditing who did what is a different concern.
- Diff renderer beyond a simple `prev → next` key/value comparison. Rich diffs deferred to a follow-up.
- Rate limiting / per-user retry budgets. We cap retries at 3 in-process; persistent retry storms are a separate problem.

## Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Helper shape | React provider + `useConfirmAndMutate()` hook | Matches existing `<ConfirmPopDialog>` pages-router pattern; singleton modal state; reactive banner via EntityStoreContext |
| Caller input | Full `Entity` snapshot | Issue text ("modal renders from snapshot"); caller already has it from cursor selection |
| Lint enforcement | **Type brand** (`DangerousToken`) | Compile-time guarantee; no Biome-rule infrastructure (Biome has no custom-rule plugin); stronger than a lint rule. Issue's "lint rule" requirement is upgraded to a type-level prevention |
| Server enforcement | Hono middleware `dangerous()` wrapping handlers | Per-route opt-in; reads `If-Match` header; rejects with 428 if missing |
| Scope | **All mutating routes** (PUT/PATCH/DELETE) across `agent-tasks`, `claims`, `sessions`, `bounties`, `goals`, `handoffs`, `outcomes`, `threads`, and mutating `contributions` routes | User chose maximal coverage. Controllers will need `get → patch(ifMatch=rv)` — the k8s pattern |
| Status codes | **428** when `If-Match` missing; **409 Conflict** with `current` snapshot when stale | 428 matches issue; 409 matches k8s convention for RV-mismatch and the issue text |
| Retry cap | 3 in-helper retries on 409, then `{ ok: false, reason: "max-retries" }` | Prevents pathological loops; surfaces persistent conflict to caller |

## Architecture

Three units, each independently testable.

### 1. Server middleware: `dangerous()`

`src/server/middleware/dangerous.ts`.

```ts
export function dangerous<E extends Env>(
  handler: Handler<E>,
  opts?: { idParam?: string },
): Handler<E> {
  return async (c) => {
    const ifMatch = c.req.header("If-Match");
    if (!ifMatch) {
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

Applied per-route in `src/server/routes/*.ts`:

```ts
agentTasks.put(
  "/:id",
  dangerous(zValidator("json", specBodySchema), { idParam: "id" }),
  async (c) => {
    const ifMatch = c.get("ifMatch") as string;
    const result = await store.putAgentTaskSpec(spec, { ifMatch });
    if (result.kind === "rv-mismatch") {
      return c.json({ error: { code: "CONFLICT", current: result.current } }, 409);
    }
    return c.json(result.view);
  },
);
```

**Why a wrapper, not a decorator**: TS lacks ergonomic runtime decorators on free functions. A wrapper keeps the application explicit (you see `dangerous(...)` at the route declaration) and avoids hidden global registration.

### 2. Store CAS: `{ ifMatch? }` option + discriminated result

Stores in `src/local/*-store.ts` and `src/nexus/*-store.ts` extend mutation methods:

```ts
type CasMutationResult<View> =
  | { kind: "ok"; view: View }
  | { kind: "rv-mismatch"; current: { resourceVersion: string; generation: number } };

interface ClaimStore {
  putClaimSpec(
    spec: ClaimSpecRecord,
    opts?: { ifMatch?: string },
  ): Promise<CasMutationResult<ClaimView>>;
  // ...
}
```

Semantics:
- `ifMatch` present + matches current RV → write, bump RV monotonically, return `{ kind: "ok", view }`
- `ifMatch` present + mismatch → return `{ kind: "rv-mismatch", current }` (no throw; route translates to 409)
- `ifMatch` absent → write proceeds (preserves existing internal/controller callers; the 428 gate at the HTTP layer is the safety net for external callers)

RV is bumped per (namespace, kind, id) on every successful write. Watch protocol (#292) already streams the new RV through the informer.

### 3. TUI helper: `<ConfirmAndMutateProvider>` + `useConfirmAndMutate`

`src/tui/safety/confirm-and-mutate.tsx`.

**Provider**, mounted at app root next to `<ConfirmPopDialog>` in `src/tui/components/pages-router.tsx`. Owns:
- Modal state machine (IDLE / OPEN / SUBMITTING)
- Subscribed snapshot via existing `useEntity(kind, id)` over EntityStoreContext
- Banner detection: when `live.resourceVersion !== snapshotAtOpen.resourceVersion`, set `banner=true`
- Retry loop on 409, capped at 3
- Token minting (via private factory, not exported from safety/index)

**Hook**:

```ts
export interface ConfirmAndMutateRequest<K extends WatchKind, R> {
  readonly entity: EntityForKind<K>;
  readonly message: string;
  readonly dangerous: true;
  readonly mutation: (token: DangerousToken<K>) => Promise<R>;
  readonly diff?: (prev: EntityForKind<K>, next: EntityForKind<K>) => React.ReactNode;
}

export type ConfirmAndMutateResult<R> =
  | { ok: true; value: R }
  | { ok: false; reason: "cancelled" | "max-retries" };

export function useConfirmAndMutate(): <K extends WatchKind, R>(
  req: ConfirmAndMutateRequest<K, R>,
) => Promise<ConfirmAndMutateResult<R>>;
```

**Modal layout**:

```
┌─ Confirm: <message> ────────────────────────────────────┐
│                                                         │
│ Kind:    AgentSession                                   │
│ Id:      sess-7f2a                                      │
│ Spec:                                                   │
│   role: reviewer                                        │
│   prompt: Wait for...                                   │
│                                                         │
│ [BANNER, when entity changed externally:]               │
│ ⚠ state changed externally — review before confirming  │
│   was rv=12 generation=4 → now rv=14 generation=5      │
│                                                         │
│ [y] confirm   [n] cancel   [r] refresh snapshot         │
└─────────────────────────────────────────────────────────┘
```

Banner trigger fires within one React tick of an EntityStore watch event; comfortably under the 200ms acceptance target.

### 4. Type brand: `DangerousToken<K>`

`src/tui/safety/internal/token.ts` (not exported from `src/tui/safety/index.ts`).

```ts
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

Only `confirm-and-mutate.tsx` (same package) imports the factory. Test-only mint is exposed via `src/tui/safety/testing.ts`:

```ts
export { mintDangerousToken as __test_only_mintToken } from "./internal/token.js";
```

Dangerous client methods on `src/nexus/nexus-http-client.ts` / `src/tui/remote-provider.ts` change signature:

```ts
// Before:
deleteSession(id: string): Promise<void>
// After:
deleteSession(token: DangerousToken<"AgentSession">): Promise<void>
// id and ifMatch read from token; method sets If-Match: token.ifMatch
```

Type guarantee: any callsite outside `src/tui/safety/` cannot construct a token through normal object literals (the `unique symbol` field is unforgeable), so it cannot call `deleteSession` — TypeScript prevents the natural bypass at compile time. A deliberate `as DangerousToken<K>` cast can still escape; that's an obviously suspicious pattern in code review and is the seam where the type system stops and human judgment starts. The 428 server gate is the defense-in-depth backstop for that case.

## Data flow

```
caller (cursor row in EntityView)
   └─ const trigger = useConfirmAndMutate();
       trigger({
         entity,                                  // snapshot
         message: "Delete session?",
         dangerous: true,
         mutation: (token) => client.deleteSession(token),
       });

provider:
   1. set state = OPEN, snapshotAtOpen = entity, banner = false
   2. subscribe useEntity(entity.kind, entity.id) → live
   3. on each live update: banner = live.resourceVersion !== snapshotAtOpen.resourceVersion
   4. on [y]: state = SUBMITTING; token = mint(entity.kind, entity.id, snapshotAtOpen.resourceVersion)
                                    await mutation(token)
       ├─ ok        → state = IDLE; resolve { ok: true, value }
       ├─ 409       → snapshotAtOpen = response.current; banner = true; retryCount++; state = OPEN
       │              (retryCount > 3 → resolve { ok: false, reason: "max-retries" })
       └─ network/server error → reject (caller surfaces via flash bar)
   5. on [n]: state = IDLE; resolve { ok: false, reason: "cancelled" }
   6. on [r]: snapshotAtOpen = live; banner = false (manual refresh, no submit)
```

## Server route changes

Routes whose mutating handlers wrap with `dangerous()` and accept `If-Match`:

| File | Routes |
|------|--------|
| `src/server/routes/agent-tasks.ts` | `PUT /:id`, `PATCH /:id/status` |
| `src/server/routes/claims.ts` | `PUT /:id`, `PATCH /:id`, `PATCH /:id/status` |
| `src/server/routes/sessions.ts` | `DELETE /:id`, any PUT/PATCH |
| `src/server/routes/contributions.ts` | mutating routes (audit) |
| `src/server/routes/bounties.ts` | mutations |
| `src/server/routes/goals.ts` | `PUT /goal` and other mutations |
| `src/server/routes/handoffs.ts` | mutations |
| `src/server/routes/outcomes.ts` | mutations |
| `src/server/routes/threads.ts` | mutations |

The full list is audited in step 3 of the migration order below; the table here lists confirmed sites.

## Controller impact

Status-PATCH loops (e.g., bridge, claim reconciler) now need `get → patch(ifMatch=rv)`. A small `src/server/middleware/with-if-match.ts` helper:

```ts
export async function withIfMatch<View, Patch>(
  read: () => Promise<{ resourceVersion: string }>,
  patch: (opts: { ifMatch: string }) => Promise<CasMutationResult<View>>,
  opts?: { maxRetries?: number },
): Promise<View>;
```

Reads RV, attempts patch, retries on rv-mismatch up to N times. The bridge already reads entities for hydration, so threading RV is mechanical.

## File layout

**New:**
```
src/tui/safety/
  index.ts                    # exports: useConfirmAndMutate, ConfirmAndMutateProvider, DangerousToken (type only)
  confirm-and-mutate.tsx      # provider + modal + retry loop
  internal/
    token.ts                  # mintDangerousToken (not exported via index)
  testing.ts                  # __test_only_mintToken
src/server/middleware/
  dangerous.ts                # 428 wrapper
  with-if-match.ts            # controller helper
```

**Changed:**
- `src/server/routes/*.ts` — wrap mutating handlers
- `src/local/*-store.ts`, `src/nexus/*-store.ts` — `{ ifMatch? }` opt, rv-mismatch result, RV bump
- `src/nexus/nexus-http-client.ts`, `src/tui/remote-provider.ts` — dangerous methods take `DangerousToken`
- `src/tui/components/pages-router.tsx` — wrap with `<ConfirmAndMutateProvider>`
- Bridge / controller files calling `PATCH /:id/status` — adopt `withIfMatch`

## Testing

### Unit — TUI component

`src/tui/safety/confirm-and-mutate.test.tsx`:
- Happy path: open → confirm → mutation receives token with correct `ifMatch` → resolves `{ ok: true }`
- Cancel: returns `{ ok: false, reason: "cancelled" }`, mutation never called
- 409 once → modal reopens with fresh snapshot from response, banner shown, retry succeeds → `{ ok: true }`
- 409 three times → `{ ok: false, reason: "max-retries" }`
- External RV change while modal open → banner appears within one React tick (assert via store-driven update)

### Unit — server middleware

`src/server/middleware/dangerous.test.ts`:
- Missing `If-Match` → 428 with `PRECONDITION_REQUIRED` error code
- Present `If-Match` → handler invoked, `c.get("ifMatch")` set correctly
- Empty `If-Match` (`""`) → treated as missing → 428

### Unit — store CAS

Per store, in `src/local/*-store.test.ts` and `src/nexus/*-store.test.ts`:
- Stale `ifMatch` → returns `{ kind: "rv-mismatch", current }`, no write to backing store
- Fresh `ifMatch` → write succeeds, RV bumps monotonically
- Without `ifMatch` (internal path) → write proceeds (back-compat)

### Type-level — bypass prevention

`src/tui/safety/types.test.ts` — uses `// @ts-expect-error` to capture compile failures:
- `client.deleteSession()` without a token → TS error
- Constructing a `DangerousToken` outside `safety/` → TS error (private factory)

This *is* the lint enforcement. Issue's "caller-bypass test (critical, enforced by lint rule)" acceptance is satisfied by this type-level test.

### E2E — handshake + 409 retry

`tests/e2e/confirm-and-mutate.tmux.test.ts` (real grove server + tmux TUI; pattern from `tests/e2e/watch-relist-tmux.ts`):
1. Spawn real grove server, attach tmux TUI
2. Open a confirm modal on a known entity
3. External mutation bumps RV (via direct API call from a second client)
4. Assert banner appears in TUI within 200ms (scrape rendered output)
5. Submit → expect 409 → modal re-renders with new snapshot
6. Submit again → succeeds

### Server contract — 428

Inside the existing server test suite: hand-crafted request to a known `@Dangerous` endpoint without `If-Match` → assert 428 + state unchanged.

## Migration order

PR-sized commits, each green on its own:

1. **Store CAS option.** Add `{ ifMatch? }` to all mutating store methods, return `CasMutationResult` discriminated union, bump RV on write. Tests per store. No route or TUI changes.
2. **`dangerous()` middleware + one route end-to-end.** Land middleware, apply to `DELETE /api/sessions/:id`, plumb through to store, including controller path if any. Server test for 428 + 409.
3. **Roll out `dangerous()`** to remaining mutating routes (audit pass over `src/server/routes/*.ts`).
4. **`DangerousToken` brand + client refactor.** Add token type + private factory, refactor dangerous client methods to take token. Per-client surface area as separate commits where feasible.
5. **`<ConfirmAndMutateProvider>` + hook + modal + retry/banner logic** with unit tests.
6. **Convert callsites** in `src/tui/views/*` and `src/tui/screens/*` to use the hook. TypeScript catches any missed callsite (won't compile).
7. **E2E tmux test.**
8. **Type-fail test** for caller-bypass.

## Open risks / mitigations

- **Controller burden**: every controller patching status must read entity first. *Mitigation*: `withIfMatch()` helper centralizes the read-patch-retry loop; bridge already reads entities for hydration.
- **Test churn in existing store tests**: dozens of tests don't pass `ifMatch`. *Mitigation*: the option is optional; existing tests stay green; new CAS-specific tests are added per store.
- **Type signature change for dangerous client methods**: every callsite must update. *Mitigation*: TypeScript surfaces every site at compile time — there's no "silent" miss. Caller refactor is mechanical: wrap in `useConfirmAndMutate().trigger(...)`.

## Acceptance — issue criteria mapping

| Issue criterion | Where satisfied |
|-----------------|-----------------|
| Modal display stable (no shifting fields) | Snapshot captured at open; modal renders from snapshot, not live |
| Concurrent mutation → warning banner within 200ms | EntityStoreContext subscription; React tick latency well below 200ms; E2E test asserts |
| Submit with stale RV → 409 → modal re-opens with fresh snapshot | Provider retry loop; `current` returned in 409 body |
| Caller-bypass test (critical, lint rule) | `DangerousToken` type brand + `types.test.ts` `@ts-expect-error` cases |
| Server 428 test | `dangerous.test.ts` + server contract test |
