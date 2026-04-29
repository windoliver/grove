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
import {
  StaleResourceVersionError,
  type WatchEvent,
  type WatchKind,
} from "../../core/watch-events.js";
import { BufferOverflowError, type WatchHub } from "../../core/watch-hub.js";
import type { ServerDeps, ServerEnv } from "../deps.js";

const KIND_VALUES = ["Contribution", "Claim", "AgentSession"] as const;

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
  const lastEventId = c.req.header("last-event-id");
  // Last-Event-ID overrides resumeFrom on auto-reconnect (browser EventSource).
  // Reject blank/non-decimal values defensively — `BigInt("")` is 0n, which
  // would silently rewind the watch to genesis and 410 once the ring evicts.
  const validLastEventId =
    lastEventId && /^[0-9]+$/.test(lastEventId) ? lastEventId : undefined;
  const fromRv = BigInt(validLastEventId ?? resumeFrom);
  const hub: WatchHub = c.get("deps").watchHub;

  // SSE-route per-connection queue cap. The WatchHub already bounds its
  // per-subscriber queue, but once a hub event is drained into the route's
  // ReadableStream, only the stream's own backpressure stops the route from
  // accumulating bytes for a stalled TCP client. Setting an explicit
  // highWaterMark + a hard overflow threshold lets us close the stream with
  // 503 buffer_overflow before the process holds unbounded bytes for one
  // client. K8s' watch http2 path uses a similar bounded write window.
  const ROUTE_HIGH_WATER_MARK = 64;
  const ROUTE_OVERFLOW_THRESHOLD = -ROUTE_HIGH_WATER_MARK * 4; // ~256 chunks queued

  const stream = new ReadableStream<Uint8Array>(
    {
    start(controller) {
      const encoder = new TextEncoder();
      const ac = new AbortController();
      let bookmarkTimer: ReturnType<typeof setInterval> | null = null;
      let closed = false;

      const isOverflowed = (): boolean => {
        const ds = controller.desiredSize;
        return ds !== null && ds <= ROUTE_OVERFLOW_THRESHOLD;
      };

      const send = (event: string, data: unknown, id?: string): void => {
        if (closed) return;
        // Only emit `id:` when we have one. A blank `id:` line tells SSE
        // clients to clear Last-Event-ID, which would silently rewind the
        // watch on reconnect.
        const idLine = id ? `id: ${id}\n` : "";
        const payload = `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          /* controller already closed */
        }
      };

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (bookmarkTimer) clearInterval(bookmarkTimer);
        bookmarkTimer = null;
        ac.abort();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const closeWithError = (code: number, reason: string): void => {
        send("ERROR", { code, reason });
        cleanup();
      };

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
        // Tag the BOOKMARK with the RV as the SSE id so EventSource auto-
        // reconnect picks up Last-Event-ID = currentRv. Without this, a
        // BOOKMARK after a real event would not advance the resume cursor.
        const rv = String(hub.currentRv(namespace, kind as WatchKind));
        send("BOOKMARK", { rv }, rv);
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
            send(ev.op, { kind: ev.kind, entity: ev.entity }, String(ev.rv));
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

      // Abort when the client disconnects.
      c.req.raw.signal.addEventListener("abort", cleanup);
    },
  },
    new CountQueuingStrategy({ highWaterMark: ROUTE_HIGH_WATER_MARK }),
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
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return [];
    }
  }
}

export { watch };
