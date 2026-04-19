# Bounded Channel Backpressure (Issue #274)

**Status:** Draft
**Date:** 2026-04-18
**Issue:** [#274](https://github.com/windoliver/grove/issues/274)
**Related:** #188 (event-driven TUI updates), #259/#260/#261 (typed ACP message streams)

## Problem

`AcpxRuntime` returns an `AcpxTurn` whose `messages: AsyncIterable<Message>` is fed directly by `AcpParser` reading the acpx child's stdout. Producer rate (agent tokens) can far exceed consumer rate (Nexus IPC publisher, TUI redraw, remote subscribers). Today there is no buffer between them.

Two failure modes follow:

1. **Unbounded buffering** — if the consumer is wrapped in something that buffers (e.g., a `for await` body that awaits HTTP), event objects pile up in V8 closures and memory grows without bound.
2. **Stalled iterator** — if backpressure is added naively (block the parser until consumer drains), the parser stops reading from the acpx pipe, the OS pipe buffer fills, the acpx child blocks on `write()`, and the agent stalls mid-turn.

A naive bounded queue with drop-oldest eviction loses semantically important events (`tool_call`, `permission_request`) — those are state changes the consumer cannot reconstruct from later events.

## Goal

Insert a bounded channel between `AcpParser` and the `AcpxTurn.messages` consumer with a per-event-kind drop policy that:

- Preserves semantic events (tool calls, permission requests, terminal text, errors).
- Coalesces cosmetic deltas (chunked `text` / `thinking`) so a slow consumer sees one merged delta per kind, not a queue of fragments.
- Drops the lowest-value events (`token_usage`, `raw`) before harming the higher-priority categories.
- Never blocks the parser. The acpx child must always be free to write its next frame.

## Non-goals

- Not redesigning SSE transport — purely the in-process channel.
- Not solving cross-process backpressure (server → remote SSE subscriber).
- Not a generic pub/sub primitive — single consumer per channel.
- Not multi-turn coalescing — channel is per `AcpxTurn` instance.

## Architecture

```
acpx stdout → AcpParser → channel.push() → ring buffer → channel[Symbol.asyncIterator] → consumer
                                          ↑
                                  policy resolver
                                  (coalesce | evict | append)
```

- **Module**: `src/acp/bounded-channel.ts` — generic `BoundedEventChannel<T>`, no ACP coupling.
- **Wiring**: `AcpxTurnImpl` constructs one channel instance, replaces parser-direct `messages` with `channel[Symbol.asyncIterator]()`.
- **Lifetime**: one channel per `AcpxTurn`. Closes when parser EOFs (existing `parser.result` resolution path).
- **Capacity**: 256 default, override via `AcpxTurnImpl({channelCapacity})`. Tests pass `Infinity` to bypass eviction code paths.

## Components

### `src/acp/bounded-channel.ts`

```ts
export type Policy = "never" | "coalesce_text_deltas" | "drop_oldest_on_full";

export interface ChannelOptions<T> {
  capacity: number;
  classify: (event: T) => Policy;
  coalesceKey?: (event: T) => string | null;       // returns key if event coalesces, null otherwise
  coalesce?: (existing: T, incoming: T) => T;      // merge fn for same-key chunked events
  invalidatesCoalesceKey?: (event: T) => string | null; // chunk:false terminal that clears tail
  onDrop?: (event: T, reason: "evicted" | "coalesced" | "no_capacity") => void;
}

export interface ChannelStats {
  pushed: number;
  coalesced: number;
  evicted: number;
  droppedByPolicy: Map<Policy, number>;
}

export class BoundedEventChannel<T> {
  constructor(opts: ChannelOptions<T>);
  push(event: T): void;        // never throws, never blocks
  close(): void;               // signals consumer EOF after buffer drains
  stats(): ChannelStats;
  [Symbol.asyncIterator](): AsyncIterator<T>;  // single consumer
}
```

**Internal state**:

- `buffer: (T | undefined)[]` of size `capacity` (ring).
- `policyAt: Policy[]` of size `capacity` — policy classification recorded at push time. Lets eviction find the oldest drop-eligible slot without re-classifying stored events.
- `head, tail, size` indices.
- `coalesceTails: Map<string, number>` — coalesce key → buffer index of the most recent un-consumed chunked event of that kind.
- `pendingResolver: ((value: IteratorResult<T>) => void) | null` — set when iterator is awaiting an empty buffer.
- `closed: boolean` — set by `close()`; iterator returns `{done:true}` once buffer drains.
- `stats` counters.

### `src/acp/turn.ts` (modified)

`AcpxTurnImpl` constructor accepts optional `channelCapacity?: number` (default 256). It builds a `BoundedEventChannel<Message>` with ACP-specific policy callbacks and pumps the existing parser-message stream into it. `this.messages` exposes `channel[Symbol.asyncIterator]()`.

Policy callbacks (live in `turn.ts`, not in the generic channel):

| `Message.kind` | Condition | Policy |
|---|---|---|
| `tool_call` | always | `never` |
| `permission_request` | always | `never` |
| `text`, `thinking` | `chunk: true` | `coalesce_text_deltas` (key = `kind`) |
| `text`, `thinking` | `chunk: false` | `never` (terminal — invalidates coalesce tail of same kind) |
| `token_usage` | always | `drop_oldest_on_full` |
| `raw` | always | `drop_oldest_on_full` |

`coalesce` for ACP merges by appending the incoming event's `text` to the existing event's `text`, preserving `chunk: true`.

## Push algorithm

Synchronous, never blocks. Pseudocode:

```
push(event):
  if closed:
    onDrop(event, "no_capacity"); return
  stats.pushed++

  policy = classify(event)

  if policy == coalesce_text_deltas:
    key = coalesceKey(event)
    if key && coalesceTails.has(key):
      idx = coalesceTails.get(key)
      buffer[idx] = coalesce(buffer[idx], event)
      stats.coalesced++
      onDrop(event, "coalesced")
      return
    # fall through to append; record tail after

  if policy == never:
    # 1. Invalidate same-kind coalesce tail if this event is a terminal
    invKey = invalidatesCoalesceKey(event)
    if invKey: coalesceTails.delete(invKey)

    # 2. Evict-to-fit: prefer "drop-eligible" victim over rejecting.
    #    Drop-eligible = any buffer slot whose stored event was classified
    #    as drop_oldest_on_full at push time. To know this without re-classifying,
    #    a parallel ring of "policy at push time" is kept (`policyAt: Policy[]`).
    if size == capacity:
      victimIdx = findOldestDropEligible()  # walk head→tail seeking policyAt[i] == drop_oldest_on_full
      if victimIdx == -1:
        # all slots are never-policy → bounded mem must win; drop incoming
        stats.droppedByPolicy[never]++
        onDrop(event, "no_capacity")
        return
      evictAt(victimIdx)
      stats.evicted++
    appendTail(event)
    return

  if policy == drop_oldest_on_full:
    if size == capacity:
      victim = buffer[head]
      evictAt(head)
      stats.evicted++
      onDrop(victim, "evicted")
    appendTail(event)
    return

# helpers
appendTail(event):
  if pendingResolver:
    # consumer is waiting on empty buffer — fast path: resolve directly,
    # do NOT buffer, do NOT record coalesce tail (event has already left).
    r = pendingResolver; pendingResolver = null
    r({value: event, done: false})
    return
  prevTailIdx = tail
  buffer[tail] = event; policyAt[tail] = policy
  tail = (tail+1) % capacity; size++
  if policy == coalesce_text_deltas: coalesceTails.set(key, prevTailIdx)

evictAt(idx):
  ev = buffer[idx]
  # if this index was a coalesce tail for any key, clear it
  for [k, i] of coalesceTails: if i == idx: coalesceTails.delete(k)
  # remove from ring (compact via head/tail tracking)
  ...
```

**Edge case — all slots are never-policy**: documented above. Drop incoming with counter increment. This signals serious downstream stall: 256 priority events accumulated without any drop-eligible to evict. Operationally observable via `stats.droppedByPolicy["never"] > 0`; alarmable.

## Consume algorithm

```
asyncIterator.next():
  if size > 0:
    ev = buffer[head]
    if head was a coalesce tail key, clear that key (consumed → no longer valid merge target)
    advance head; size--
    return {value: ev, done: false}
  if closed:
    return {value: undefined, done: true}
  # buffer empty, not closed → wait
  return new Promise(resolve => pendingResolver = resolve)
```

Push that finds non-null `pendingResolver` resolves it directly without going through the buffer (fast path). For coalesce events on the fast path: no tail recorded, since the event left the channel synchronously.

## Error handling & edge cases

**Producer errors**: parser already emits malformed lines as `{kind:"raw", acpMethod:"_parseError"}`. These flow through the channel as `drop_oldest_on_full` policy — no special handling.

**Parser EOF**: existing `parser.result` resolution path calls `channel.close()`. Buffered events drain to consumer first, then iterator returns `{done:true}`.

**Consumer breaks early** (`for await ... of` with `break`): iterator's `return()` invoked → channel marks `closed`. Subsequent pushes are silently dropped via `onDrop(event, "no_capacity")` with policy counter increment for diagnostics.

**Cancel during turn**: `AcpxTurn.cancel()` → child SIGINT → parser EOFs → channel closes naturally. Already-buffered events still drain (consumer chooses to read or break).

**Concurrency**: single-threaded JS; push and consumer share the event loop — no locking. `pendingResolver` invariant: nulled before resolve to prevent re-resolve.

**Memory bound**: `O(capacity)` event slots. Coalesce-merged text strings can grow but represent one un-consumed delta run; bounded by `consumer slowness × producer text rate`. If this becomes a concern, future work can cap the merged string length.

**Backwards compat**: `AcpxTurn.messages` consumers see no API change. `AcpxTurnImpl` constructor adds optional `channelCapacity?: number`; unset = 256 default.

**Test bypass**: `AcpxTurnImpl({channelCapacity: Infinity})` → channel uses unbounded array; eviction code paths skipped (coalesce + stats still work). Useful for tests that need exact event ordering without policy interference.

## Observability

- `channel.stats()` returns `{pushed, coalesced, evicted, droppedByPolicy}`. Pull-based — operators or tests scrape on demand.
- `onDrop(event, reason)` optional callback fires per event drop. Wires to logs, EventBus, or test assertions.

Future work (out of scope here): expose stats via Nexus EventBus emission so operator dashboards can render `dropped_events_total{kind, slot_id}` over time.

## Testing

**`src/acp/bounded-channel.test.ts`** (unit, generic — no ACP coupling):

1. Basic push/consume — push 3, consume 3, verify order.
2. Capacity bound — push `capacity+10` drop_oldest events, consumer reads `capacity` newest.
3. Coalesce hot path — push 100 chunked text, buffer holds 1, `stats.coalesced == 99`.
4. Coalesce key isolation — interleave text + thinking chunked deltas, verify each kind coalesces independently.
5. Coalesce tail invalidation on consume — coalesce builds tail; consumer pulls it; next chunked text becomes a new entry (not merged into consumed event).
6. Coalesce tail invalidation on terminal — chunked text run, then chunk:false text → tail cleared, next chunked text is new entry.
7. Never-policy evicts drop-eligible — fill with drop_oldest events; push tool_call → evicts oldest, tool_call appended.
8. Never-policy with no drop-eligible — fill with never-policy; push tool_call → dropped, `droppedByPolicy["never"]` increments.
9. `onDrop` callback fires per coalesce + eviction with correct reason.
10. `stats` accuracy under mixed push.
11. Iterator awaits empty — consumer iter pending; push resolves it without going through buffer (fast path).
12. Close drains then EOFs — push 3, close, consumer reads 3 then `{done:true}`.
13. Consumer break cleanup — `for await` with `break` after 1; subsequent push silently dropped, channel marked closed.

**`src/acp/turn.test.ts`** (integration with `AcpxTurnImpl`):

14. Default capacity 256 — construct without opts, push 257 drop_oldest, oldest evicted.
15. `channelCapacity: Infinity` bypasses eviction — push 1000, consumer reads all in order.
16. Real ACP message classification — push one of each `Message` kind, verify policy applied (via stats inspection).
17. Slow consumer simulation — push 500 chunked text via parser stub at high rate, consumer reads at low rate; verify final coalesced count and no memory blow-up.

Existing coverage retained:

- Cross-turn behavior covered by `src/core/acpx-runtime.test.ts`.
- Real `acpx --format json --json-strict` E2E covered by `src/core/acpx-runtime.component.test.ts`. No new E2E required.

## Open questions

None at design time. The channel is a self-contained primitive; the consumer side (#261 publisher) integrates by simply iterating `turn.messages` as it does today.
