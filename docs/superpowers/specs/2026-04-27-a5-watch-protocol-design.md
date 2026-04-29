# A5: Watch Protocol — list→watch RV Handshake — Design

- **Issue**: [#292](https://github.com/windoliver/grove/issues/292)
- **Epic**: [#282](https://github.com/windoliver/grove/issues/282) — Foundation: Entity Model + Watch Protocol
- **Date**: 2026-04-27
- **Depends on**: #287 (Entity envelope), #290 (Namespace enforcement)
- **Reference**: `kubernetes/staging/src/k8s.io/apimachinery/pkg/watch/watch.go`

## Goal

Provide a reactive watch protocol with a strict list→watch resourceVersion (RV)
handshake so that TUI clients can list a kind, then resume a watch from the
exact RV the list snapshot was taken at, and receive every subsequent event
without gaps. This is the foundation that retires polling reactive paths in
the TUI (#295) and that the informer cache (#294) builds on.

The "list-from-listRv then watch-from-latest" anti-pattern is the silent
desync bug this design exists to prevent: any event written between
list-return and watch-establishment must be guaranteed to land on the
watcher's stream.

## Non-goals

- Persistent watch log across server restart. In-memory ring buffers only;
  on restart, watchers must re-list. K8s informers handle this transparently.
- Multi-grove-server consensus. Grove deploys one server per worktree, so a
  single in-memory RV authority is sufficient. Cross-server agreement is a
  future concern (and out of scope for the foundation epic).
- Field or label selectors. Only `kind` and namespace (auth-derived) filter
  the watch. Label filtering is client-side post-watch — labels live for
  intra-namespace filtering only per #290.
- TUI consumer integration. A7 (#294) wires informer clients; A5 ships the
  server protocol and a thin internal subscribe API.
- Polling retirement. A8 (#295) deletes the polling timers once watch lands.
- Compaction / Expired RV recovery. A6 (#293) adds smarter handling of stale
  RVs; A5 simply emits a 410-equivalent error event when `resumeFrom` falls
  outside the ring buffer.
- Outcome / Bounty / Handoff watch. Future kinds extend the same hub, but
  A5 ships only the three Entity kinds defined in #287.

## RV authority

A per-(namespace, kind) monotonic counter lives in grove-server memory inside
a new `WatchHub`. Writes feed the counter from two paths:

1. **Fast path — in-process**: the operations layer (`contribute`, `claim`,
   etc.) calls `onEntityWrite` post-commit. The server's deps wire this to
   `hub.recordWrite()`.
2. **Catch-all — Nexus event-bus**: writes from a different process (e.g. an
   MCP agent calling `grove_contribute` from a separate Bun process) reach
   grove-server via a new `entity.changed` Nexus topic. grove-server
   subscribes and feeds the same hub.

Duplicate suppression is keyed on `(kind, id, generation)`: if both paths fire
for the same write, the second is a no-op.

This is the C-lite option from brainstorming. Server-local-only (A) silently
misses cross-process writes; pure Nexus-derived (B) requires a new Nexus
brick that exposes a per-(ns,kind) sequence which Nexus does not natively
provide. C-lite ships A5 with what we have and treats the brick as a future
optimization.

### Two RV namespaces (do not conflate)

| RV | Lives on | Monotonic over | Used for |
|----|----------|----------------|----------|
| `entity.resourceVersion` (existing, #287) | Each Entity row | A single entity's revision history | Optimistic concurrency on writes |
| Watch RV (new) | WatchHub `(ns, kind)` counter | The kind in a namespace | list→watch handshake, SSE event ids |

The watch event payload carries the per-row `entity.resourceVersion` for the
client's downstream use; the SSE event id and `listResourceVersion` are the
watch RV. They look similar (numeric strings) but are independent.

## Architecture

```
                ┌──────────────────────────────────────────┐
                │            grove-server                  │
                │                                          │
   write op ──► │  WatchHub                                │
   (operations  │   ├── per-(ns,kind) RV counters         │
    layer,      │   ├── ring buffers (1024 events / 5min) │
    in-process) │   └── active SSE subscribers             │
                │                                          │
   Nexus ──►    │  GET /api/list?kind=X                    │
   event-bus    │  GET /api/watch?kind=X&resumeFrom=Y      │
   subscription │                                          │
   (cross-proc) │                                          │
                └──────────────────────────────────────────┘
                                ▲
                       TUI informer (A7, #294)
```

## Endpoint shape

Two new endpoints, both behind the existing `namespaceAuth` middleware. The
namespace is auth-derived (#290); never accepted as a query parameter.

### `GET /api/list?kind=<kind>`

Response:
```json
{
  "items": [ /* Entity<...>[] */ ],
  "listResourceVersion": "42"
}
```

Implementation must capture the watch RV **before** invoking
`store.listEntities()`. This is the race-correctness invariant: any write
that lands during the list query has rv > listRv, so it is guaranteed to be
in the ring buffer when the watch resumes.

```typescript
// server/routes/watch.ts
const namespace = c.get("namespace");
const kind = parseKind(c.req.valid("query").kind);
const listRv = hub.currentRv(namespace, kind);  // BEFORE list
const items = await store.listEntities({ namespace });
return c.json({ items, listResourceVersion: String(listRv) });
```

Reverse order would silently miss writes interleaved with list — that is the
specific bug this design exists to prevent.

### `GET /api/watch?kind=<kind>&resumeFrom=<rv>`

Returns `Content-Type: text/event-stream`. `resumeFrom` is required and is
NEVER `"latest"`. The server replays all events with `rv > resumeFrom` from
the ring buffer, then tails new events on the same stream.

`Last-Event-ID` (set automatically by browser EventSource on auto-reconnect)
overrides `resumeFrom` if present, so reconnect after a network blip is
transparent to the client.

Event types:

| Type | Payload | Meaning |
|------|---------|---------|
| `ADDED` | `{rv, kind, entity}` | New entity appeared |
| `MODIFIED` | `{rv, kind, entity}` | Existing entity changed |
| `DELETED` | `{rv, kind, entity}` | Entity removed (snapshot at deletion) |
| `BOOKMARK` | `{rv}` | Periodic checkpoint, no entity change |
| `ERROR` | `{code, reason}` | Terminal — stream closes after this event |

Each event carries an SSE `id:` field equal to its `rv`, and an `event:`
field naming the type. Bookmarks are emitted at minimum once per 30s per
active stream (acceptance criterion #3).

## Components

### `src/core/watch-hub.ts` (new)

Pure-logic, no HTTP. Lives in core because both server route handlers and
test helpers (race test) need to inject hooks.

```typescript
export type WatchKind = "Contribution" | "Claim" | "AgentSession";
export type WatchOp = "ADDED" | "MODIFIED" | "DELETED";

export interface WatchEvent {
  readonly rv: bigint;
  readonly op: WatchOp;
  readonly kind: WatchKind;
  readonly namespace: string;
  readonly entity:
    | ContributionEntity
    | ClaimEntity
    | AgentSessionEntity;
}

export interface WatchHubOptions {
  readonly maxEventsPerKey?: number;       // default 1024
  readonly maxAgeMsPerKey?: number;        // default 5 * 60_000
  readonly bookmarkIntervalMs?: number;    // default 30_000
  readonly perClientOutboxCap?: number;    // default 256
}

export class WatchHub {
  constructor(opts?: WatchHubOptions);

  /** Record a write. Bumps the (ns, kind) counter and emits to subscribers.
   *  Returns the new watch RV. */
  recordWrite(event: Omit<WatchEvent, "rv">): bigint;

  /** Read the current watch RV without bumping. Captured by the list
   *  endpoint BEFORE store.listEntities() to prevent the handshake race. */
  currentRv(namespace: string, kind: WatchKind): bigint;

  /** Subscribe with replay-from semantics. Throws StaleResourceVersionError
   *  if fromRv < ringBuffer.oldestRv for that (ns, kind). The iterable
   *  yields replay events first, then tails until aborted. */
  subscribe(
    namespace: string,
    kind: WatchKind,
    fromRv: bigint,
    signal: AbortSignal,
  ): AsyncIterable<WatchEvent>;
}

export class StaleResourceVersionError extends Error {
  readonly code = 410;
}
```

Internal state:
```typescript
type KeyState = {
  counter: bigint;                  // monotonic per (ns, kind)
  ring: WatchEvent[];               // bounded by maxEvents AND maxAgeMs
  ringInsertedAt: number[];         // parallel to ring, for age trim
  subscribers: Set<Subscriber>;     // active SSE clients
};
private readonly state = new Map<string /* "ns/kind" */, KeyState>();
```

Per-subscriber outbox is a bounded `AsyncQueue` with a hard cap. On overflow,
the subscriber is closed with a `BufferOverflowError` so the SSE handler can
emit the terminal `ERROR` event.

### `src/core/operations/deps.ts` (modify)

Extend `OperationDeps` with:
```typescript
readonly onEntityWrite?:
  | ((event: {
      kind: WatchKind;
      namespace: string;
      op: WatchOp;
      entity:
        | ContributionEntity
        | ClaimEntity
        | AgentSessionEntity;
    }) => void)
  | undefined;
```

The hook fires post-commit, in addition to the existing
`onContributionWrite` / `onContributionWritten` callbacks (they remain — they
are used by other consumers and have different semantics: write-side
flush coordination, not watch fan-out).

### `src/core/operations/contribute.ts` (modify)

After successful commit, project the contribution to its Entity envelope and
fire `onEntityWrite({kind: "Contribution", namespace, op: "ADDED", entity})`.
The contribute operation has no MODIFIED path (contributions are immutable);
DELETED is reserved for compaction and out of scope here.

Equivalent hooks land in any operation that writes a Claim or AgentSession.
Claim emits ADDED on `createClaim` / `claimOrRenew` (first write), MODIFIED
on lease renewal and status transition, DELETED on `cleanCompleted` for
terminal-state rows. **Heartbeat MODIFIED events are filtered**: a heartbeat
that does not change `status` or cross the lease-expiry boundary in
`claimToEntity` is suppressed at the hook site, because heartbeats arrive
several times per second per active claim and would flood the ring buffer
with no semantic change for watchers. The lease-expiry-crossed boundary
(when `resourceVersion` flips to `"<rev>-lease-expired"`) DOES emit, since
that is a logical state change observable by consumers.

AgentSession emits ADDED on first appearance, MODIFIED on phase change
(`running` ↔ `idle` ↔ `stopped` ↔ `crashed`). DELETED is not used in A5 —
sessions are retained for history; future cleanup pathways will emit DELETED
when they land.

### `src/server/routes/watch.ts` (new)

Hono route module for `/api/list` and `/api/watch`. Mounts behind the
existing `namespaceAuth` middleware — namespace flows from `c.get("namespace")`,
never query params.

The watch handler uses Bun's stream-friendly `Response` with
`Content-Type: text/event-stream`. Bookmark timer is a per-stream
`setInterval(bookmarkIntervalMs)`. Stream lifecycle is bound to an
`AbortController` so client disconnect / server shutdown cleanly removes the
subscription from `WatchHub`.

### `src/nexus/nexus-watch-publisher.ts` (new)

Called by Nexus stores after a write. Publishes a structured event to the
`entity.changed` Nexus topic carrying `{kind, namespace, op, entityId,
generation}`. Lightweight payload — full entity is re-fetched on the
subscriber side so the wire format does not bake in entity shape.

### `src/nexus/nexus-watch-subscriber.ts` (new)

grove-server subscribes to `entity.changed` at startup. On receipt:
1. De-duplicate: if `(kind, id, generation)` was already recorded by the
   in-process fast path within the last N ms, drop.
2. Otherwise fetch the full entity from the appropriate store and call
   `hub.recordWrite()`.

Dedup window: 5s — long enough to absorb event-bus latency, short enough that
genuine subsequent writes at the same generation (which shouldn't happen but
defense-in-depth) aren't masked.

### `src/server/serve.ts` (modify)

- Instantiate `WatchHub` at startup.
- Wire `onEntityWrite` into the operations deps factory.
- If Nexus is configured, start `NexusWatchSubscriber`.
- Pass `hub` into ServerEnv deps so route handlers can access it.

### `src/server/deps.ts` (modify)

Add `watchHub: WatchHub` to `ServerDeps`.

### `src/server/app.ts` (modify)

Mount `watch` routes under `/api`. Routes are gated by the existing
namespace-auth middleware automatically.

### `src/nexus/nexus-contribution-store.ts` and peers (modify)

After every write, call `nexusWatchPublisher.publish({...})`. Same for
`nexus-claim-store.ts`, `nexus-session-store.ts`. This is the cross-process
catch-all path.

## Error handling

| Condition | Server response | Client action |
|-----------|-----------------|---------------|
| Missing `kind` query param | HTTP 400 `{code: VALIDATION_ERROR}` | Fix request |
| Missing/invalid auth | HTTP 401/400 (existing #290 middleware) | Re-auth |
| `resumeFrom < ring.oldestRv` | SSE `event: ERROR data: {code: 410, reason: "expired"}`, then close | Re-list, restart watch |
| Per-client outbox overflow | SSE `event: ERROR data: {code: 503, reason: "buffer_overflow"}`, then close | Re-list, restart watch |
| Server restart | TCP close | Reconnect → fresh list |
| Network blip | TCP close | EventSource auto-reconnects with `Last-Event-ID` header → server uses as `resumeFrom` |

## Testing strategy

### Unit — `src/core/watch-hub.test.ts`

- RV monotonicity: `recordWrite` returns strictly increasing rv per (ns, kind), independent across pairs.
- Ring buffer cap: at `maxEventsPerKey`, oldest is evicted; subscribe with rv < oldest throws `StaleResourceVersionError`.
- Ring buffer age cap: events older than `maxAgeMsPerKey` are evicted on read.
- Replay correctness: subscribe(fromRv=N) yields exactly events with rv > N then tails new.
- Bookmark cadence: ≥1 emit per `bookmarkIntervalMs` per active subscription.
- Per-client outbox overflow: slow consumer triggers bounded-queue close with `BufferOverflowError`.
- Namespace isolation: writes to ns=A do not appear in subscribe(ns=B).
- Kind isolation: writes to kind=Contribution do not appear in subscribe(kind=Claim) for the same ns.

### Integration — `src/server/watch.test.ts`

- `GET /api/list?kind=Contribution` returns `{items, listResourceVersion}` with auth; 401 without; 400 without `kind`.
- `GET /api/watch` opens SSE, emits `ADDED` after a `POST /api/contributions`.
- Stale RV: write past ring cap, `resumeFrom=stale` → `ERROR` event with `code: 410`, then close.
- Cross-process via Nexus subscriber: a write into the Nexus VFS by a separate test client surfaces on a watch opened against the server.

### Acceptance — `src/server/watch.race.test.ts` (issue criterion #2)

```typescript
test("handshake race: writes between list-return and watch-open all replayed", async () => {
  // Test-only hook: WatchHub takes an injectable beforeListHook so the test
  // can inject a 100ms delay between hub.currentRv() and store.listEntities().
  const N = 50;
  const listRv = await beginList();
  const writes = await Promise.all(
    Array.from({ length: N }, (_, i) => writeContribution(i)),
  );
  const items = await endList();
  const events = await collectWatch(listRv, { timeoutMs: 1_000 });
  expect(events.length).toBe(N);
  expect(events.map(e => e.entity.id).sort()).toEqual(
    writes.map(w => w.cid).sort()
  );
});
```

### Acceptance — `src/server/watch.kill.test.ts` (issue criterion #1)

- Open watch, receive bookmark `rv=K`.
- Force-close client by aborting the underlying stream (simulates `kill -9`).
- Write M=20 events while disconnected (well under the 1024 ring cap).
- Reconnect with `resumeFrom=K` → assert all M events replayed in order, no duplicates.

### Acceptance — bookmark cadence (issue criterion #3)

- Open watch on a quiescent (ns, kind), no writes.
- Assert at least one BOOKMARK event arrives within `bookmarkIntervalMs + slack` (33s).
- Carry-current-RV: payload `rv` matches `hub.currentRv()` at emit time.

## File changes summary

**New**:
- `src/core/watch-hub.ts`
- `src/core/watch-hub.test.ts`
- `src/server/routes/watch.ts`
- `src/server/watch.test.ts`
- `src/server/watch.race.test.ts`
- `src/server/watch.kill.test.ts`
- `src/nexus/nexus-watch-publisher.ts`
- `src/nexus/nexus-watch-subscriber.ts`

**Modified**:
- `src/core/operations/deps.ts` — add `onEntityWrite` hook field
- `src/core/operations/contribute.ts` — fire `onEntityWrite` post-commit
- Operations that mutate Claim or AgentSession — same fire site
- `src/server/serve.ts` — instantiate WatchHub, wire callback + Nexus subscriber
- `src/server/deps.ts` — add `watchHub`
- `src/server/app.ts` — mount `/api/list`, `/api/watch`
- `src/nexus/nexus-contribution-store.ts`, `nexus-claim-store.ts`,
  `nexus-session-store.ts` — call publisher after writes

## Open questions deferred

- Whether to expose watch over WebSocket as a future alternative (SSE-only for A5).
- Compaction window for ring buffers when a kind sees a sustained burst >
  cap. A6 (#293) addresses this; A5's behavior is "drop oldest, return 410
  on stale resume."
- TUI informer cache shape, including whether informers share a single
  watch per kind across panels. A7 (#294).
