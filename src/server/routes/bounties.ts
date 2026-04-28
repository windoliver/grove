/**
 * Bounty endpoints.
 *
 * GET /api/bounties — List bounties with optional status/creator filters.
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { BountyStatus } from "../../core/bounty.js";
import type { BountyQuery } from "../../core/bounty-store.js";
import type { ServerEnv } from "../deps.js";

const listQuerySchema = z.object({
  status: z
    .enum([
      BountyStatus.Draft,
      BountyStatus.Open,
      BountyStatus.Claimed,
      BountyStatus.PendingSettlement,
      BountyStatus.Completed,
      BountyStatus.Settled,
      BountyStatus.Expired,
      BountyStatus.Cancelled,
    ])
    .optional(),
  creatorAgentId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const bounties: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /api/bounties — List bounties. */
bounties.get("/", zValidator("query", listQuerySchema), async (c) => {
  const { bountyStore } = c.get("deps");
  if (!bountyStore) {
    return c.json(
      { error: { code: "NOT_CONFIGURED", message: "Bounty store is not configured" } },
      501,
    );
  }

  const { status, creatorAgentId, limit } = c.req.valid("query");

  const query: BountyQuery = {
    ...(status !== undefined ? { status } : {}),
    ...(creatorAgentId !== undefined ? { creatorAgentId } : {}),
    ...(limit !== undefined ? { limit } : {}),
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
