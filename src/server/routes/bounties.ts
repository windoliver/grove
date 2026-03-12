/**
 * Bounty endpoints.
 *
 * GET /api/bounties — List bounties with optional status/creator filters.
 */

import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import type { BountyStatus } from "../../core/bounty.js";
import type { BountyQuery } from "../../core/bounty-store.js";
import type { ServerEnv } from "../deps.js";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const bounties: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /api/bounties — List bounties. */
bounties.get("/", async (c) => {
  const { bountyStore } = c.get("deps");
  if (!bountyStore) {
    return c.json(
      { error: { code: "NOT_CONFIGURED", message: "Bounty store is not configured" } },
      501,
    );
  }

  const status = c.req.query("status");
  const creatorAgentId = c.req.query("creatorAgentId");
  const limit = c.req.query("limit");

  const query: BountyQuery = {
    ...(status ? { status: status as BountyStatus } : {}),
    ...(creatorAgentId ? { creatorAgentId } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  };

  const results = await bountyStore.listBounties(query);
  return c.json({ bounties: results });
});

/** GET /api/bounties/:id — Get a single bounty. */
bounties.get("/:id", async (c) => {
  const { bountyStore } = c.get("deps");
  if (!bountyStore) {
    return c.json(
      { error: { code: "NOT_CONFIGURED", message: "Bounty store is not configured" } },
      501,
    );
  }

  const bountyId = c.req.param("id");
  const bounty = await bountyStore.getBounty(bountyId);
  if (!bounty) {
    return c.json({ error: { code: "NOT_FOUND", message: `Bounty not found: ${bountyId}` } }, 404);
  }
  return c.json(bounty);
});

export { bounties };
