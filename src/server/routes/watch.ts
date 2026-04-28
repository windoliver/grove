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
  const items = await listForKind(deps, namespace, kind as WatchKind);

  return c.json({ items, listResourceVersion: String(listRv) });
});

/** GET /api/watch?kind=X&resumeFrom=Y — SSE stream. */
watch.get("/watch", zValidator("query", watchQuerySchema), (c) => {
  const namespace = c.get("namespace");
  const { kind, resumeFrom } = c.req.valid("query");
  const lastEventId = c.req.header("last-event-id");
  // Last-Event-ID overrides resumeFrom on auto-reconnect (browser EventSource).
  const fromRv = BigInt(lastEventId ?? resumeFrom);
  const hub: WatchHub = c.get("deps").watchHub;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const ac = new AbortController();
      let bookmarkTimer: ReturnType<typeof setInterval> | null = null;
      let closed = false;

      const send = (event: string, data: unknown, id?: string): void => {
        if (closed) return;
        const payload = `id: ${id ?? ""}\nevent: ${event}\ndata: ${JSON.stringify(
          data,
        )}\n\n`;
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
        send("BOOKMARK", {
          rv: String(hub.currentRv(namespace, kind as WatchKind)),
        });
      }, hub.bookmarkIntervalMs);
      // Don't hold the event loop open just for this timer.
      (bookmarkTimer as unknown as { unref?: () => void }).unref?.();

      void (async () => {
        try {
          for await (const ev of iterable) {
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
  });

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
