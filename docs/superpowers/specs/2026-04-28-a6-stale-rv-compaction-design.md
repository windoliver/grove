# A6: Stale-RV (Expired) Error Path + Compaction Semantics — Design

- **Issue**: [#293](https://github.com/windoliver/grove/issues/293)
- **Epic**: [#282](https://github.com/windoliver/grove/issues/282) — Foundation: Entity Model + Watch Protocol
- **Date**: 2026-04-28
- **Depends on**: [#292](https://github.com/windoliver/grove/issues/292) (A5 watch protocol)
- **Blocks**: [#294](https://github.com/windoliver/grove/issues/294) (A7 informer client)
- **Reference**: `k8s.io/apimachinery/pkg/api/errors.NewResourceExpired`,
  `k8s.io/apimachinery/pkg/watch`

## Goal

Close the retention/compaction gap on top of the watch protocol shipped in
#292. When a client's `resumeFrom` falls outside the server's ring buffer,
the server returns a typed `Expired` (HTTP 410) error and the client
recovers by re-running the A5 list→watch handshake — no events lost, no
silent skips. Retention window is configurable and observable; eviction is
counted and surfaced via a metrics endpoint.

The "silently skip past the gap" anti-pattern is the desync bug this design
prevents. K8s informers solve it with `Replace()` after a relist; #293 ships
the equivalent contract for grove's watch.

## Non-goals

- Persistent watch log across server restart. In-memory ring buffer only —
  same constraint as #292. On restart, RV resets to 0 and clients must
  re-list (#292 already returns 410 for `resumeFrom > currentRv`).
- Full informer (`Map<id, Entity>` + handler fanout). That is #294.
  #293 ships a thin `WatchClient` helper that #294 will wrap.
- Polling retirement in the TUI. That is #295.
- Prometheus / OpenMetrics format. JSON metrics endpoint only — promotable
  later when there is broader demand for a `/metrics` scrape surface.
- Multi-server retention coordination. Single grove-server per worktree
  (same as #292).
- Adaptive retention (sized by burst load). Fixed retention with operator-
  set bounds; tuning is an ops decision, not a runtime adaptation.

## Architecture

```
                      grove-server (single process)
   ┌──────────────────────────────────────────────────────────────┐
   │                                                              │
   │  WatchHub                                                    │
   │   ├── per-(ns,kind) RV counter                               │
   │   ├── ring buffer (bounded by maxEvents AND maxAgeMs)        │
   │   ├── compaction stats {evictedByAge, evictedByCapacity,    │
   │   │                     currentRingSize, oldestRv}           │
   │   └── trim() increments stats on each eviction               │
   │                                                              │
   │  GET /api/watch/metrics  ← new (#293)                        │
   │     → JSON: per-(ns,kind) compaction stats + retention cfg   │
   │                                                              │
   │  GET /api/list?kind=X    ← from #292                         │
   │  GET /api/watch?kind=X&resumeFrom=Y                          │
   │     → on stale rv → SSE event:ERROR data:{code:410,          │
   │                       reason:"expired"} → close              │
   └──────────────────────────────────────────────────────────────┘
                            ▲
                            │  list → watch → on-410 relist
                            │
                ┌───────────┴───────────┐
                │   WatchClient (new)   │
                │  - run({onEvent})     │
                │  - handles 410/503    │
                │  - reconnect+backoff  │
                └───────────────────────┘
                            ▲
                            │  wraps
                            │
                  Informer (future, #294)
```

### Boot config

`serve.ts` reads two env vars and passes them to `new WatchHub(...)`:

| Env var | Default | Range (clamped) | Meaning |
|---------|---------|-----------------|---------|
| `GROVE_WATCH_RETENTION_MS` | `300_000` (5 min) | `[1_000, 86_400_000]` | Max age of any event in the ring buffer |
| `GROVE_WATCH_MAX_EVENTS` | `1024` | `[16, 1_000_000]` | Max events per `(ns, kind)` ring |

Out-of-range or unparseable values fall back to default with a
`console.warn`. Clamping protects against ops typos like
`GROVE_WATCH_RETENTION_MS=-5` (silently disables retention) or
`...=999999999999` (eats memory).

### Data flow on Expired

1. Client opens `GET /api/watch?resumeFrom=42`.
2. Server's `WatchHub.subscribe` throws `StaleResourceVersionError` because
   `oldestRv = 200` (or `currentRv < 42` after a server restart).
3. Watch route catches the error and emits
   `event: ERROR\ndata: {"code":410,"reason":"expired"}\n\n`, then closes.
4. `WatchClient` parses the ERROR event, increments local `relistCount`,
   awaits any in-flight `onEvent` callback, then re-issues
   `GET /api/list?kind=X`.
5. New `listResourceVersion` (e.g., 247) becomes the new `resumeFrom`. The
   client fires `op:"RELIST"` events for every item in the snapshot, then
   reopens the watch from `listRv`.
6. The race-correctness invariant from #292 closes the gap: any write that
   landed between "see 410" and "list returns" has `rv > listRv` and is
   guaranteed to be in the ring on watch resume.

### Why `RELIST` op tagging

A consumer reading from `WatchClient` needs to know "your local cache is
stale, here is the full state, replace it." Without an explicit signal, the
consumer would treat a relist's events as deltas and double-insert.
Kubernetes informers solve this with `Replace()` on the cache; our minimal
client surfaces it as a typed callback signal so #294's informer (and any
direct consumer in the meantime) can implement `Replace`-style reconciliation
trivially.

`RELIST` events all carry the same `rv` (the `listResourceVersion` returned
by `/api/list`). A consumer can track "last RELIST rv seen" and clear any
local entries whose last-seen rv is older — that is the standard informer
reconcile loop.

## Components

### `src/core/watch-hub.ts` (modify)

Extend internal state with compaction counters:

```typescript
interface KeyState {
  counter: bigint;
  ring: WatchEvent[];
  insertedAt: number[];
  evictedByAge: number;       // new
  evictedByCapacity: number;  // new
}
```

`trim()` increments the right counter on each shift. Pre-existing trim
logic stays — we only add observability:

```typescript
private trim(s: KeyState): void {
  while (s.ring.length > this.maxEventsPerKey) {
    s.ring.shift();
    s.insertedAt.shift();
    s.evictedByCapacity += 1;
  }
  const cutoff = this.now() - this.maxAgeMsPerKey;
  while (s.ring.length > 0 && (s.insertedAt[0] ?? 0) < cutoff) {
    s.ring.shift();
    s.insertedAt.shift();
    s.evictedByAge += 1;
  }
}
```

Public API additions:

```typescript
export interface CompactionStats {
  readonly namespace: string;
  readonly kind: WatchKind;
  readonly evictedByAge: number;
  readonly evictedByCapacity: number;
  readonly currentRingSize: number;
  readonly oldestRv: string;   // bigint as decimal string
  readonly currentRv: string;
}

export class WatchHub {
  // ... existing members ...
  readonly maxAgeMsPerKey: number;     // promote to public for /metrics
  readonly maxEventsPerKey: number;    // promote to public for /metrics

  /** Snapshot of compaction counters across all (ns, kind) keys. */
  getCompactionStats(): readonly CompactionStats[];
}
```

Counters are monotonic and never reset within a process lifetime. They
survive `subscribe`/`unsubscribe` cycles; only the ring buffer entries
change. No behavior change to `recordWrite` / `subscribe`.

### `src/server/routes/watch.ts` (modify)

Add a third route:

```
GET /api/watch/metrics
  → 200 JSON
    {
      "retention": {
        "maxAgeMs": 300000,
        "maxEvents": 1024
      },
      "keys": [
        {
          "namespace": "abc-123",
          "kind": "Contribution",
          "evictedByAge": 12,
          "evictedByCapacity": 0,
          "currentRingSize": 87,
          "oldestRv": "5",
          "currentRv": "104"
        },
        ...
      ]
    }
```

`keys` is filtered to `c.get("namespace")` so namespaces don't leak each
other's traffic shape. The route sits behind the same `namespaceAuth`
middleware as the rest of `/api/*`. No query parameters.

### `src/core/watch-client.ts` (new)

Thin client. ~150 LOC. No dependencies beyond `fetch` + `EventSource`,
both injectable for tests.

```typescript
export type WatchClientOp = "ADDED" | "MODIFIED" | "DELETED" | "RELIST";

export interface WatchClientEvent {
  readonly op: WatchClientOp;
  readonly rv: bigint;
  readonly kind: WatchKind;
  readonly entity: WatchEntity;
}

export interface WatchClientOptions {
  readonly baseUrl: string;
  readonly kind: WatchKind;
  readonly authHeader: string;
  readonly fetch?: typeof fetch;
  readonly EventSource?: typeof EventSource;
  readonly backoff?: {
    readonly minMs: number;     // default 100
    readonly maxMs: number;     // default 30_000
    readonly jitter: number;    // default 0.3 (multiplicative)
  };
}

export class WatchClient {
  constructor(opts: WatchClientOptions);

  /**
   * Runs list→watch loop until aborted. Calls onEvent for each delta
   * (ADDED/MODIFIED/DELETED) and for relist replay (RELIST). Errors only
   * on terminal misconfig (e.g., 401, 400, 501); 410/503/network blips
   * trigger reconnect with backoff.
   *
   * onEvent is awaited sequentially — sequential delivery is contract.
   */
  run(opts: {
    onEvent: (e: WatchClientEvent) => Promise<void> | void;
    signal: AbortSignal;
  }): Promise<void>;
}
```

**Loop**:

1. `GET /api/list?kind=X` → `{ items, listResourceVersion }`.
2. For each item, fire `onEvent({op:"RELIST", rv:listRv, kind, entity})`.
   RELIST signals "snapshot, not delta".
3. Open `GET /api/watch?kind=X&resumeFrom=listRv` (SSE).
4. For each `ADDED|MODIFIED|DELETED` event, await `onEvent`.
5. On `event:ERROR` with `code:410` or `code:503`: backoff (with jitter),
   goto 1 (full relist).
6. On TCP close / non-410 network error: backoff, reopen watch with
   last-seen `rv` as `resumeFrom` (fast resume — no relist). Initial value
   is the `listRv` from step 1, so a TCP close before any events still
   resumes correctly.
7. On `event:ERROR` 4xx other than 410: terminal — `run()` rejects.
8. Stop when `signal.aborted`.

**Backoff state machine**:
- `delay = max(minMs, min(maxMs, prevDelay × 2)) × (1 ± jitter)`
- Reset to `minMs` on first successful SSE data event after reconnect.
- Reset on 410/503 too — relist is a clean slate.

**Sequential onEvent**: `run()` awaits each `onEvent` before processing the
next event. Consumers (incl. future informer) need this for cache
consistency. Callers wanting concurrency manage it themselves inside
`onEvent`.

**Abort semantics**: on `signal.abort()`, `run()` waits for any in-flight
`onEvent` to settle, tears down the EventSource, and resolves cleanly. No
dangling promises or zombie subscriptions.

### `src/server/serve.ts` (modify)

Read env vars at boot and pass to `WatchHub`:

```typescript
import { clampInt } from "../util/clamp.js";  // small new util

const watchRetentionMs = clampInt({
  raw: process.env.GROVE_WATCH_RETENTION_MS,
  fallback: 300_000,
  min: 1_000,
  max: 86_400_000,
  name: "GROVE_WATCH_RETENTION_MS",
});
const watchMaxEvents = clampInt({
  raw: process.env.GROVE_WATCH_MAX_EVENTS,
  fallback: 1024,
  min: 16,
  max: 1_000_000,
  name: "GROVE_WATCH_MAX_EVENTS",
});

const watchHub = new WatchHub({
  maxAgeMsPerKey: watchRetentionMs,
  maxEventsPerKey: watchMaxEvents,
});
```

`clampInt` lives in `src/util/clamp.ts`, logs `console.warn` on out-of-range
or unparseable values, and falls back to `fallback`. Trivially unit-tested
on its own.

### Documentation

- **`docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md`**: edit
  the "Open questions deferred" section — strike the compaction line and
  link to #293.
- **`docs/parity-matrix.md`**: add a row documenting `GROVE_WATCH_RETENTION_MS`,
  `GROVE_WATCH_MAX_EVENTS`, the 410/expired contract, and the metrics
  endpoint.

## Error handling

| Condition | Server emits | `WatchClient` action |
|-----------|--------------|----------------------|
| `resumeFrom < oldestRv` (sleep past retention) | `event:ERROR data:{code:410, reason:"expired"}` then close | Relist via A5 → fire `RELIST` events → reopen from `listRv` |
| `resumeFrom > currentRv` (server restart, RV reset) | `event:ERROR data:{code:410, reason:"expired"}` (existing #292 — `StaleResourceVersionError` covers both directions) | Same: relist |
| Per-client outbox overflow | `event:ERROR data:{code:503, reason:"buffer_overflow"}` then close | Same as 410: relist (slow consumer is now fresh) |
| Per-event >1 MiB | `event:ERROR data:{code:503, reason:"buffer_overflow"}` (existing #292) | Same: relist |
| TCP close / network blip | (no event) | Reopen with last-seen `rv` as `resumeFrom`, exponential backoff, no relist |
| HTTP 401 / 403 | JSON `{code:UNAUTHENTICATED}` | Terminal — `run()` rejects |
| HTTP 400 (validation) | JSON `{code:VALIDATION_ERROR}` | Terminal — bug |
| HTTP 501 (kind unsupported) | JSON `{code:NOT_CONFIGURED}` | Terminal — kind not yet wired |
| Malformed SSE 5× consecutively | (parse error in client) | Terminal — `run()` rejects |

**Race during relist**: between "see 410" and "list returns", new writes
may land. Those are visible in the new `listRv`. The watch resumes from
`listRv`, so the gap is closed by construction (same handshake guarantee
as #292's `watch.race.test.ts`).

## Testing strategy

### Unit — `src/core/watch-hub.compaction.test.ts` (new)

- `evictedByAge` increments when an event is trimmed via `now() > insertedAt + maxAgeMs` (inject fake `now`).
- `evictedByCapacity` increments when ring exceeds `maxEventsPerKey`.
- `getCompactionStats()` returns one entry per active `(ns, kind)`, with
  correct `currentRingSize`, `oldestRv`, `currentRv`. Bigint serialized as
  decimal string.
- Stats persist across `subscribe`/`unsubscribe` cycles.
- `currentRv` reflects total writes ever, not ring size.
- Empty `(ns, kind)` (counter created but ring empty) reports `currentRingSize: 0` and `oldestRv: "0"`.

### Unit — `src/core/watch-client.test.ts` (new)

Inject mock `fetch` + mock `EventSource`. No real network.

- **Happy path**: list returns 3 items → 3 `RELIST` events → watch streams
  `ADDED` → forwarded as `op:"ADDED"` to `onEvent`.
- **410 → relist**: watch emits `ERROR{code:410}` → client reissues
  `GET /api/list` → fires fresh `RELIST` events → reopens watch.
- **503 → relist**: same as 410.
- **TCP close, no error event**: client reopens watch from last `rv` (no relist).
- **Backoff schedule**: 3 consecutive failures → delays follow exponential
  schedule (deterministic with seeded jitter).
- **Backoff reset on success**: failure → success → next failure starts at `minMs`.
- **Backoff reset on 410**: relist is a fresh start.
- **`onEvent` awaited sequentially**: slow async `onEvent` blocks subsequent
  dispatch until resolved.
- **Abort during in-flight `onEvent`**: `signal.abort()` mid-callback →
  `run()` resolves after callback settles, no events dispatched after abort.
- **Terminal 401**: `run()` rejects; no relist loop.
- **Terminal 501**: same.
- **Malformed SSE 5×**: terminal error.

### Unit — `src/util/clamp.test.ts` (new)

- Unparseable returns fallback + warns.
- Below min returns fallback + warns.
- Above max returns fallback + warns.
- Within range returns parsed.
- Empty / undefined returns fallback (no warn — env unset is normal).

### Integration — `src/server/watch.compaction.test.ts` (new)

Real `WatchHub`, tiny config (`maxAgeMsPerKey: 200`, `maxEventsPerKey: 4`).

- **Sleep past retention** (acceptance #1): write event at rv=1, advance
  fake clock past retention, write more events → `GET /api/watch?resumeFrom=1`
  → SSE `ERROR{code:410, reason:"expired"}`, stream closes.
- **Capacity-based eviction**: write 10 events into a 4-event ring →
  `resumeFrom=1` → 410.
- **Metrics endpoint** (acceptance #4): after evictions,
  `GET /api/watch/metrics` returns `evictedByAge` ≥ 1 and
  `evictedByCapacity` ≥ 1, plus `retention.maxAgeMs` and
  `retention.maxEvents` matching boot config.
- **Metrics namespace isolation**: namespace A's metrics endpoint doesn't
  see namespace B's keys.
- **Env-var config**: with `GROVE_WATCH_RETENTION_MS=1000` set,
  `GET /api/watch/metrics` reports `retention.maxAgeMs: 1000`.
- **Env-var clamping**: `GROVE_WATCH_RETENTION_MS=-5` falls back to default
  + logs warning.

### E2E — `src/server/watch.relist.e2e.test.ts` (new) (acceptance #2)

Real `WatchClient` against an in-process Hono test server.

```typescript
test("client relists across retention gap with no missed events", async () => {
  const server = await startTestServer({
    watchRetentionMs: 100,
    watchMaxEvents: 4,
  });
  const seen: WatchClientEvent[] = [];
  const client = new WatchClient({
    baseUrl: server.url,
    kind: "Contribution",
    authHeader: server.authHeader,
  });
  const ac = new AbortController();
  const running = client.run({
    onEvent: async (e) => { seen.push(e); },
    signal: ac.signal,
  });

  // Phase 1: write 3 events, observe via watch.
  await postContribution(server, "a");
  await postContribution(server, "b");
  await postContribution(server, "c");
  await waitFor(() => seen.filter(e => e.op === "ADDED").length === 3);

  // Phase 2: simulate kill -9 + sleep past retention.
  await server.pauseClient(client);  // intercept fetch with 503 mid-stream
  await advanceClock(server, 500);   // > 100ms retention
  await postContribution(server, "d");
  await postContribution(server, "e");

  // Phase 3: resume client → must relist + cover the gap.
  await server.resumeClient(client);
  await waitFor(() => seen.filter(e => e.entity.id === "e").length >= 1);

  // Every contribution surfaced. RELIST may repeat ids that ADDED already
  // delivered — consumer reconciles via id+rv.
  const ids = new Set(seen.map(e => e.entity.id));
  expect(ids).toEqual(new Set(["a","b","c","d","e"]));
  expect(seen.some(e => e.op === "RELIST")).toBe(true);

  ac.abort();
  await running;
});
```

Plumbing notes:
- WatchHub's `now` is already injectable; bookmark interval is the real
  timer. Test uses short bookmark (50ms) and short retention (100ms) so
  wallclock time suffices — no fake `setInterval` needed.
- `pauseClient` injects a fetch wrapper that returns 503 between
  pause/resume to emulate disconnect.
- Real Sqlite + real Hono. No mocked stores.

### Manual smoke

```sh
GROVE_WATCH_RETENTION_MS=5000 grove-server start
sleep 6
curl -N "${GROVE_URL}/api/watch?kind=Contribution&resumeFrom=1" \
  -H "Authorization: Bearer ${GROVE_TOKEN}"
# → expects: event: ERROR\ndata: {"code":410,"reason":"expired"}
```

## File changes summary

**New**:
- `src/core/watch-client.ts`
- `src/core/watch-client.test.ts`
- `src/core/watch-hub.compaction.test.ts`
- `src/server/watch.compaction.test.ts`
- `src/server/watch.relist.e2e.test.ts`
- `src/util/clamp.ts`
- `src/util/clamp.test.ts`

**Modified**:
- `src/core/watch-hub.ts` — add compaction counters, `getCompactionStats()`,
  promote `maxAgeMsPerKey` / `maxEventsPerKey` to public.
- `src/core/watch-events.ts` — no change (`StaleResourceVersionError`
  already covers both stale-low and stale-high cases).
- `src/server/routes/watch.ts` — add `GET /api/watch/metrics`.
- `src/server/serve.ts` — read `GROVE_WATCH_RETENTION_MS` /
  `GROVE_WATCH_MAX_EVENTS`, clamp, pass to `WatchHub`.
- `docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md` —
  resolve "Open questions deferred" compaction entry.
- `docs/parity-matrix.md` — document retention + metrics endpoint.

## Acceptance traceability

| Issue criterion | Where covered |
|-----------------|---------------|
| Sleep past retention window → resume returns `Expired` | `watch.compaction.test.ts` "sleep past retention" |
| Client relists via A5 handshake automatically → no events missed | `watch.relist.e2e.test.ts` |
| Retention window configurable + documented | env vars in `serve.ts`, `parity-matrix.md`, this design |
| Compaction metric exposed | `GET /api/watch/metrics` + `getCompactionStats()` |

## Open questions deferred

- **Per-kind retention**: today `maxAgeMs` / `maxEvents` are global to the
  `WatchHub`. If `Claim` watchers see 100× the rate of `Contribution`, the
  Claim ring will evict aggressively while Contribution barely uses its
  capacity. Per-kind tuning is a future ops knob — out of scope for #293.
- **Retention SLO surfaced to clients**: `GET /api/watch/metrics` exposes
  the configured retention but not a "how often did we evict in the last
  N minutes" rate. A future histogram or rate counter would help ops alert
  on chronic relist storms. Defer until #294 informers reveal the access
  patterns.
- **Prometheus scrape format**: defer until ops asks. JSON satisfies the
  acceptance criterion today.
