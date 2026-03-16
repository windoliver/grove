/**
 * Grove metadata endpoint.
 *
 * GET /api/grove — Returns grove metadata (version, stats).
 */

import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import type { ServerEnv } from "../deps.js";

const grove: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /api/grove — Grove instance metadata. */
grove.get("/", async (c) => {
  const { contributionStore, claimStore, gossip: gossipService } = c.get("deps");

  const contributionCount = await contributionStore.count();
  const activeClaimCount = await claimStore.countActiveClaims();

  return c.json({
    version: "0.1.0",
    protocol: {
      manifestVersion: 1,
    },
    stats: {
      contributions: contributionCount,
      activeClaims: activeClaimCount,
    },
    gossip: gossipService
      ? {
          enabled: true,
          peers: gossipService.peers().length,
          liveness: gossipService.liveness().map((l) => ({
            peerId: l.peer.peerId,
            status: l.status,
            lastSeen: l.lastSeen,
          })),
        }
      : { enabled: false },
  });
});

/** GET /api/grove/topology — Agent topology configuration. */
grove.get("/topology", (c) => {
  const { topology } = c.get("deps");
  if (!topology) {
    return c.json({ error: { code: "NOT_FOUND", message: "Topology is not configured" } }, 404);
  }
  return c.json(topology);
});

export { grove };
