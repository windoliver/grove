/**
 * Watch protocol endpoints (#292).
 *
 * GET /api/list?kind=<kind>      — list snapshot with listResourceVersion
 * GET /api/watch?kind=<kind>&resumeFrom=<rv> — SSE stream
 *
 * Both endpoints sit behind the existing /api/* namespaceAuth middleware
 * (#290), so namespace is always read from `c.get("namespace")` — never
 * from query or path params.
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { claimToEntity, contributionToEntity } from "../../core/entity.js";
import {
  StaleResourceVersionError,
  type WatchEvent,
  type WatchKind,
} from "../../core/watch-events.js";
import { BufferOverflowError, type WatchHub } from "../../core/watch-hub.js";
import type { ServerDeps, ServerEnv } from "../deps.js";

const KIND_VALUES = ["Contribution", "Claim", "AgentSession"] as const;
// Subset of KIND_VALUES for which list+watch are actually backed by
// stores and fan-out hooks. AgentSession remains in KIND_VALUES so the
// type narrowing stays exhaustive, but watching it returns 501 until
// the session-orchestrator integration lands (out of scope for #292).
const SUPPORTED_KINDS: ReadonlySet<(typeof KIND_VALUES)[number]> = new Set([
  "Contribution",
  "Claim",
]);

const listQuerySchema = z.object({
  kind: z.enum(KIND_VALUES),
});

const watchQuerySchema = z.object({
  kind: z.enum(KIND_VALUES),
  resumeFrom: z.string().regex(/^[0-9]+$/, "resumeFrom must be a non-negative integer"),
});

const watch: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /api/list?kind=X — list snapshot with listResourceVersion. */
watch.get("/list", zValidator("query", listQuerySchema), async (c) => {
  const namespace = c.get("namespace");
  const { kind } = c.req.valid("query");
  if (!SUPPORTED_KINDS.has(kind)) {
    return c.json(
      {
        error: {
          code: "NOT_CONFIGURED",
          message: `kind '${kind}' is accepted by the schema but not yet backed by a store; list is unavailable`,
        },
      },
      501,
    );
  }
  const deps = c.get("deps");
  const hub: WatchHub = deps.watchHub;

  // Race-correctness invariant (spec §Critical path): capture RV BEFORE the
  // list query. Any write that lands during the list has rv > listRv and is
  // therefore guaranteed to be replayed when the watch resumes.
  const listRv = hub.currentRv(namespace, kind as WatchKind);
  // Test-only widening of the handshake window. See watch.race.test.ts (#292).
  const delayMs = Number(process.env.GROVE_WATCH_LIST_DELAY_MS);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  const items = await listForKind(deps, namespace, kind as WatchKind);

  return c.json({ items, listResourceVersion: String(listRv) });
});

/** GET /api/watch?kind=X&resumeFrom=Y — SSE stream. */
watch.get("/watch", zValidator("query", watchQuerySchema), (c) => {
  const namespace = c.get("namespace");
  const { kind, resumeFrom } = c.req.valid("query");
  if (!SUPPORTED_KINDS.has(kind)) {
    return c.json(
      {
        error: {
          code: "NOT_CONFIGURED",
          message: `kind '${kind}' is accepted by the schema but not yet backed by fan-out hooks; watch would silently miss events`,
        },
      },
      501,
    );
  }
  const lastEventId = c.req.header("last-event-id");
  // Last-Event-ID overrides resumeFrom on auto-reconnect (browser EventSource).
  // If present but malformed, fail fast with 400 — silently falling back to
  // the URL's resumeFrom would let a stale URL rewind the client past
  // recently-seen events, causing duplicate replay or stale 410.
  if (lastEventId !== undefined && !/^[0-9]+$/.test(lastEventId)) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Last-Event-ID must be a non-negative decimal integer",
        },
      },
      400,
    );
  }
  const fromRv = BigInt(lastEventId ?? resumeFrom);
  const hub: WatchHub = c.get("deps").watchHub;

  // SSE-route per-connection byte cap. The WatchHub already bounds its
  // per-subscriber queue, but once a hub event is drained into the route's
  // ReadableStream, only the stream's own backpressure stops the route from
  // accumulating bytes for a stalled TCP client. Per-event payload size is
  // unbounded (large entities), so a chunk-count threshold could still let
  // tens-to-hundreds of MB queue per client; use ByteLengthQueuingStrategy
  // so desiredSize is measured in bytes instead of chunks. K8s' watch http2
  // path uses a similar bounded write window.
  const ROUTE_BYTE_HIGH_WATER_MARK = 1 * 1024 * 1024; // 1 MiB
  // desiredSize can go negative when overshooting; cap at -3 MiB so total
  // queued bytes stay under ~4 MiB per client before we 503.
  const ROUTE_BYTE_OVERFLOW_THRESHOLD = -3 * 1024 * 1024;

  // Hoisted out of start() so the stream's cancel() handler can fire the
  // same teardown when the consumer cancels the response body without
  // routing through the request abort signal (some HTTP/2 proxies and
  // body.cancel() callers do this).
  let teardown: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const encoder = new TextEncoder();
        const ac = new AbortController();
        let bookmarkTimer: ReturnType<typeof setInterval> | null = null;
        let closed = false;
        let reqSignal: AbortSignal | null = null;
        let onReqAbort: (() => void) | null = null;

        const isOverflowed = (): boolean => {
          const ds = controller.desiredSize;
          return ds !== null && ds <= ROUTE_BYTE_OVERFLOW_THRESHOLD;
        };

        // Per-event hard cap. Even within byte budget, a single huge frame
        // would force the queue into deep-negative desiredSize between
        // overflow checks. Watch consumers that produce >1 MiB events should
        // chunk through the entity store, not the watch stream.
        const ROUTE_MAX_EVENT_BYTES = 1 * 1024 * 1024;

        const send = (event: string, data: unknown, id?: string): boolean => {
          if (closed) return false;
          // Only emit `id:` when we have one. A blank `id:` line tells SSE
          // clients to clear Last-Event-ID, which would silently rewind the
          // watch on reconnect.
          const idLine = id ? `id: ${id}\n` : "";
          const payload = `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          const bytes = encoder.encode(payload);
          // Reject oversized single events before they overshoot the queue.
          // The terminal ERROR/cleanup path may still call send() inside this
          // guard — that path uses small fixed payloads and is not affected.
          if (bytes.byteLength > ROUTE_MAX_EVENT_BYTES) return false;
          // If this single event would push the queue into hard-overflow
          // before the next iteration's check, treat it as overflow now.
          const ds = controller.desiredSize;
          if (ds !== null && ds - bytes.byteLength <= ROUTE_BYTE_OVERFLOW_THRESHOLD) {
            return false;
          }
          try {
            controller.enqueue(bytes);
          } catch {
            // Controller already closed — treat as send failure so callers
            // can run their terminal path (close/cleanup) instead of
            // silently dropping the frame.
            return false;
          }
          return true;
        };

        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          if (bookmarkTimer) clearInterval(bookmarkTimer);
          bookmarkTimer = null;
          if (reqSignal !== null && onReqAbort !== null) {
            reqSignal.removeEventListener("abort", onReqAbort);
            onReqAbort = null;
          }
          ac.abort();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        teardown = cleanup;

        // Terminal frames bypass the byte-overflow gate. send() refuses to
        // enqueue when desiredSize is past ROUTE_BYTE_OVERFLOW_THRESHOLD —
        // but the entire reason we're closing is overflow, and accepting
        // one small ERROR frame on an over-budget queue is what the client
        // depends on to receive the 503 signal (otherwise it sees plain EOF
        // and fast-resumes into the same overflow loop).
        const sendTerminal = (event: string, data: unknown): void => {
          if (closed) return;
          const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          const bytes = encoder.encode(payload);
          try {
            controller.enqueue(bytes);
          } catch {
            /* already closed */
          }
        };

        const closeWithError = (code: number, reason: string): void => {
          sendTerminal("ERROR", { code, reason });
          cleanup();
        };

        // Wire up the request-disconnect listener BEFORE subscribing.
        // AbortSignal listeners are not retroactive — registering after
        // hub.subscribe() leaves a window where the client can disconnect
        // and the subscription/timer would leak until later overflow or
        // process exit.
        reqSignal = c.req.raw.signal;
        if (reqSignal.aborted) {
          // Already disconnected before we got here. Don't subscribe.
          cleanup();
          return;
        }
        onReqAbort = (): void => {
          if (reqSignal !== null && onReqAbort !== null) {
            reqSignal.removeEventListener("abort", onReqAbort);
            onReqAbort = null;
          }
          cleanup();
        };
        reqSignal.addEventListener("abort", onReqAbort, { once: true });

        let iterable: AsyncIterable<WatchEvent>;
        try {
          iterable = hub.subscribe(namespace, kind as WatchKind, fromRv, ac.signal);
        } catch (err) {
          if (err instanceof StaleResourceVersionError) {
            closeWithError(410, "expired");
            return;
          }
          throw err;
        }

        bookmarkTimer = setInterval(() => {
          // A stalled reader on a quiescent watch would otherwise let
          // BOOKMARK frames pile up forever — they don't trip the
          // data-event overflow check below. Reuse the same threshold so
          // both code paths cap memory identically.
          if (isOverflowed()) {
            closeWithError(503, "buffer_overflow");
            return;
          }
          // Tag the BOOKMARK with the RV as the SSE id so EventSource auto-
          // reconnect picks up Last-Event-ID = currentRv. Without this, a
          // BOOKMARK after a real event would not advance the resume cursor.
          const rv = String(hub.currentRv(namespace, kind as WatchKind));
          // send() returns false when the queue can't accept another frame
          // (overflow headroom, oversized payload, controller already closed).
          // Treat this exactly like a data-path overflow so the watcher is
          // closed and the hub subscription is released — silently dropping
          // a bookmark would leave the timer + subscription alive forever
          // on a stalled idle client.
          if (!send("BOOKMARK", { rv }, rv)) {
            closeWithError(503, "buffer_overflow");
          }
        }, hub.bookmarkIntervalMs);
        // Don't hold the event loop open just for this timer.
        (bookmarkTimer as unknown as { unref?: () => void }).unref?.();

        void (async () => {
          try {
            for await (const ev of iterable) {
              if (isOverflowed()) {
                closeWithError(503, "buffer_overflow");
                return;
              }
              const rv = String(ev.rv);
              // Include rv in the JSON body so clients that only parse `data`
              // (no SSE `lastEventId` access) can still resume. Matches the
              // BOOKMARK shape and the A5 contract.
              const sent = send(
                ev.op,
                { rv, kind: ev.kind, entity: ev.entity, emittedAt: new Date().toISOString() },
                rv,
              );
              // send() refuses oversized events or events that would push the
              // queue past the overflow threshold. Either case is terminal —
              // skipping the event silently would let the client miss writes.
              if (!sent) {
                closeWithError(503, "buffer_overflow");
                return;
              }
            }
            cleanup();
          } catch (err) {
            if (err instanceof BufferOverflowError) {
              closeWithError(503, "buffer_overflow");
            } else {
              closeWithError(500, "internal_error");
            }
          }
        })();
      },
      cancel() {
        // Reader cancel (response body cancelled) — release the hub
        // subscription and bookmark timer even when the request abort
        // signal didn't fire.
        teardown?.();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: ROUTE_BYTE_HIGH_WATER_MARK }),
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

/** GET /api/watch/metrics — retention config + per-(ns,kind) compaction stats. */
watch.get("/watch/metrics", async (c) => {
  const namespace = c.get("namespace");
  const hub: WatchHub = c.get("deps").watchHub;
  const allStats = hub.getCompactionStats();
  // Filter to caller's namespace so namespaces don't leak each other's
  // traffic shape. The request is already authenticated by namespaceAuth.
  const keys = allStats.filter((s) => s.namespace === namespace);
  return c.json(
    {
      retention: {
        maxAgeMs: hub.maxAgeMsPerKey,
        maxEvents: hub.maxEventsPerKey,
      },
      keys,
    },
    200,
    {
      "Cache-Control": "private, no-store",
      Vary: "Authorization",
    },
  );
});

// ---------------------------------------------------------------------------
// POST /api/watch/notify — cross-process WatchHub event injection.
//
// MCP / agent processes write contributions/claims directly to Nexus VFS.
// grove-server's WatchHub only fires for writes performed through grove-
// server's own Nexus*Store wrappers (see NexusWatchPublisher), so without
// a bridge those out-of-process writes are invisible to /api/watch
// subscribers.
//
// This endpoint is the bridge: MCP POSTs an entity identifier to
// grove-server, which re-reads the canonical entity from its own store
// and fires watchHub.recordWrite. SSE consumers see the event the same
// way they would for an in-process write.
//
// Auth: same namespaceAuth middleware as the rest of /api/* — the caller
// must hold a key for this server's namespace.
//
// Trust boundary: the request payload is NOT trusted as the entity body
// nor as the operation type. We accept only `kind`, `entityId`, and an
// optional `sessionId` (so we can route to the session-scoped store
// where MCP agents actually write). The server probes its authoritative
// store and decides ADDED/MODIFIED (row present) vs. DELETED (absent).
// Without this:
//
//   - A namespace-key holder could forge an ADDED with arbitrary body
//     and inject ghost rows into clients' Informer caches.
//   - A namespace-key holder could forge a DELETED for any known id and
//     evict the row from every connected watcher until next relist.
//
// We always emit the hydrated current row when found — even if the
// caller's `generation` is older than the store's. By the time we land
// here, the store is the authoritative view; broadcasting current state
// is correct under any race because subscribers reconcile by id+rv. The
// generation field is accepted only for diagnostic logging.
// ---------------------------------------------------------------------------

const watchNotifySchema = z.object({
  kind: z.enum(KIND_VALUES),
  op: z.enum(["ADDED", "MODIFIED", "DELETED"]).optional(),
  entityId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  generation: z.number().int().nonnegative().optional(),
});

interface MaybeVersioned {
  readonly id?: string;
  readonly metadata?: { readonly generation?: number };
}

/**
 * Hydrate the canonical entity for a notify event.
 *
 * Uses point lookups (`store.get(id)`) instead of list scans because
 * `listEntities()` is TTL-cached (~2s) and is invalidated only by
 * writes performed in *this* process. A cross-process MCP write that
 * triggers `/api/watch/notify` would otherwise hit a warm list cache,
 * miss the brand-new row, and force the route to synthesize DELETED.
 *
 * `store.get()` has its own per-cid cache, but a miss falls through to
 * a direct Nexus read — so a freshly-committed cid that was never read
 * before always returns live data.
 */
async function hydrateEntity(
  deps: ServerDeps,
  namespace: string,
  kind: WatchKind,
  entityId: string,
): Promise<MaybeVersioned | undefined> {
  // Bridge fan-out path: only the zone-root view is broadcast. Session-
  // scoped lookups happen at the route, *before* this function is
  // called, so we can short-circuit on a real scoped hit. Any caller
  // that reaches here is asking the zone-root store directly.
  if (kind === "Contribution") {
    const flat = await deps.contributionStore.get(entityId);
    if (flat !== undefined) {
      return contributionToEntity(flat, namespace) as MaybeVersioned;
    }
    return undefined;
  }
  if (kind === "Claim") {
    // Claims are not content-addressed: a single claimId can transition
    // active → released → expired across processes. Bypass the per-id
    // cache so a previously-read snapshot doesn't shadow the new state.
    const flat = await deps.claimStore.getClaim(entityId, { bypassCache: true });
    if (flat !== undefined) {
      return claimToEntity(flat, () => Date.now(), namespace) as MaybeVersioned;
    }
    return undefined;
  }
  // Unsupported kinds are rejected at the route entry; this path is
  // unreachable but kept for type exhaustiveness.
  return undefined;
}

watch.post("/watch/notify", zValidator("json", watchNotifySchema), async (c) => {
  const namespace = c.get("namespace");
  const { kind, entityId, sessionId } = c.req.valid("json");

  // Fail-fast: only kinds with both a list endpoint and a watch fan-out
  // are accepted. AgentSession passes the schema but has no point-lookup
  // and no list-store backing, so silently emitting DELETED for it would
  // mask miswiring as "data loss" rather than surface it.
  if (!SUPPORTED_KINDS.has(kind)) {
    return c.json(
      {
        error: {
          code: "NOT_CONFIGURED",
          message: `kind '${kind}' is accepted by the schema but not yet backed by a store; notify is unavailable`,
        },
      },
      501,
    );
  }

  const deps = c.get("deps") as ServerDeps;
  const hub: WatchHub = deps.watchHub;

  // Session-scoped contribution writes cannot be safely fanned out to
  // the namespace-global watch stream: the watch hub keys on
  // (namespace, kind) and `/api/list` reads only the unscoped store, so
  // an unscoped subscriber would ingest a row that the next relist must
  // delete. Decide skip vs fan-out from BOTH stores: skip only when
  // the row lives in the session tree AND not also at zone root.
  // Same content-addressed CID can legitimately exist in both trees,
  // and a root write coming from a session-bound process must still
  // fan out globally.
  if (kind === "Contribution" && sessionId !== undefined && deps.contributionStoreForSession) {
    const scoped = deps.contributionStoreForSession(sessionId);
    const [scopedHit, rootHit] = await Promise.all([
      scoped.get(entityId),
      deps.contributionStore.get(entityId),
    ]);
    if (scopedHit !== undefined && rootHit === undefined) {
      // Truly session-only: skip global fan-out. Scoped feeds run on
      // the polled path until /api/list and /api/watch carry sessionId
      // end-to-end.
      return c.json({
        ok: true,
        op: "skipped",
        reason: "session_scoped_not_broadcast",
      });
    }
    // Either the row is also in the root tree (legitimate global event)
    // or only in the root tree (caller stamped sessionId for context).
    // Either way: fall through and let the zone-root hydration emit it.
  }

  const found = await hydrateEntity(deps, namespace, kind as WatchKind, entityId);

  if (found === undefined) {
    // Server's view: row is absent, so this is a delete. Caller cannot
    // forge a delete for a live row because we just re-checked the store.
    hub.recordWrite({
      kind: kind as WatchKind,
      namespace,
      op: "DELETED",
      entity: { id: entityId } as never,
    });
    return c.json({ ok: true, op: "DELETED" });
  }

  // ADDED vs MODIFIED is a hint to subscribers, not a security boundary;
  // honor caller's hint (default MODIFIED). Forbid DELETED when found.
  const hintOp = c.req.valid("json").op ?? "MODIFIED";
  const op = hintOp === "DELETED" ? "MODIFIED" : hintOp;
  hub.recordWrite({ kind: kind as WatchKind, namespace, op, entity: found as never });
  return c.json({ ok: true, op });
});

async function listForKind(
  deps: ServerDeps,
  namespace: string,
  kind: WatchKind,
): Promise<readonly unknown[]> {
  void namespace;
  switch (kind) {
    case "Contribution":
      return deps.contributionStore.listEntities();
    case "Claim":
      return deps.claimStore.listEntities();
    case "AgentSession":
      // AgentSession listing is not yet a Store API. Return empty until the
      // session-orchestrator integration lands (out of scope for #292).
      return [];
    case "WorkBlock":
    case "TimelineEvent":
      // Timeline persistence is introduced after the core contracts.
      return [];
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return [];
    }
  }
}

export { watch };
