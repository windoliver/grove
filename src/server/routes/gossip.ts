/**
 * Gossip endpoints.
 *
 * POST /api/gossip/exchange — Push-pull frontier exchange with a peer.
 * POST /api/gossip/shuffle  — CYCLON peer sampling shuffle.
 * GET  /api/gossip/peers    — List known peers and liveness.
 * GET  /api/gossip/frontier — Merged frontier from gossip (local + remote).
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { MAX_GOSSIP_FRONTIER_ENTRIES, MAX_GOSSIP_OFFERED_PEERS } from "../../core/constants.js";
import { GossipAuthError, verifyPayload } from "../../gossip/protocol.js";
import type { ServerEnv } from "../deps.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const frontierDigestEntrySchema = z.object({
  metric: z.string(),
  value: z.number(),
  cid: z.string(),
  tags: z.array(z.string()).optional(),
  direction: z.enum(["minimize", "maximize"]).optional(),
});

const capabilitiesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()]).optional(),
);

const gossipMessageSchema = z
  .object({
    peerId: z.string().min(1),
    address: z.string().optional(),
    frontier: z.array(frontierDigestEntrySchema).max(MAX_GOSSIP_FRONTIER_ENTRIES),
    load: z.object({ queueDepth: z.number().int().min(0) }),
    capabilities: capabilitiesSchema,
    timestamp: z.string(),
    // Preserve all signed fields (hmacSignature, etc.) so verifyPayload can check them.
  })
  .passthrough();

const peerInfoSchema = z.object({
  peerId: z.string().min(1),
  address: z.string().min(1),
  age: z.number().int().min(0),
  lastSeen: z.string(),
});

const shuffleRequestSchema = z
  .object({
    sender: peerInfoSchema,
    offered: z.array(peerInfoSchema).max(MAX_GOSSIP_OFFERED_PEERS),
    // Preserve signed fields (hmacSignature, etc.) for verifyPayload.
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const gossip: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** POST /api/gossip/exchange — Handle incoming gossip exchange. */
gossip.post("/exchange", zValidator("json", gossipMessageSchema), async (c) => {
  const { gossip: gossipService, gossipHmacSecret } = c.get("deps");
  if (!gossipService) {
    return c.json({ error: { code: "NOT_CONFIGURED", message: "Gossip is not enabled" } }, 501);
  }

  const message = c.req.valid("json");
  if (
    gossipHmacSecret &&
    !verifyPayload(message as unknown as Record<string, unknown>, gossipHmacSecret)
  ) {
    return c.json(
      { error: { code: "GOSSIP_AUTH_FAILED", message: "Invalid or missing HMAC signature" } },
      401,
    );
  }
  try {
    const response = await gossipService.handleExchange(message);
    return c.json(response);
  } catch (err) {
    if (err instanceof GossipAuthError) {
      return c.json({ error: { code: "GOSSIP_AUTH_FAILED", message: err.message } }, 401);
    }
    throw err;
  }
});

/** POST /api/gossip/shuffle — Handle incoming CYCLON shuffle. */
gossip.post("/shuffle", zValidator("json", shuffleRequestSchema), async (c) => {
  const { gossip: gossipService, gossipHmacSecret } = c.get("deps");
  if (!gossipService) {
    return c.json({ error: { code: "NOT_CONFIGURED", message: "Gossip is not enabled" } }, 501);
  }

  const request = c.req.valid("json");
  if (
    gossipHmacSecret &&
    !verifyPayload(request as unknown as Record<string, unknown>, gossipHmacSecret)
  ) {
    return c.json(
      { error: { code: "GOSSIP_AUTH_FAILED", message: "Invalid or missing HMAC signature" } },
      401,
    );
  }
  const response = gossipService.handleShuffle(request);
  return c.json(response);
});

/** GET /api/gossip/peers — List known peers with liveness status. */
gossip.get("/peers", (c) => {
  const { gossip: gossipService } = c.get("deps");
  if (!gossipService) {
    return c.json({ error: { code: "NOT_CONFIGURED", message: "Gossip is not enabled" } }, 501);
  }

  return c.json({
    peers: gossipService.peers(),
    liveness: gossipService.liveness(),
  });
});

/** GET /api/gossip/frontier — Get the merged frontier from gossip. */
gossip.get("/frontier", (c) => {
  const { gossip: gossipService } = c.get("deps");
  if (!gossipService) {
    return c.json({ error: { code: "NOT_CONFIGURED", message: "Gossip is not enabled" } }, 501);
  }

  return c.json({
    entries: gossipService.mergedFrontier(),
  });
});

export { gossip };
