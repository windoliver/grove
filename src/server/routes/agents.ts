/**
 * Agent management routes for gossip-aware remote spawning.
 *
 * Enables federated agent delegation: when a peer is at capacity,
 * it can delegate work to a peer with available slots via
 * POST /api/agents/spawn.
 *
 * (Issue #90, Feature 6: Gossip-aware agent spawning)
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import type { ServerEnv } from "../deps.js";

// ---------------------------------------------------------------------------
// File-local schemas (not exported — avoids isolatedDeclarations issues)
// ---------------------------------------------------------------------------

const spawnBodySchema = z.object({
  role: z.string().min(1),
  command: z.string().optional(),
  targetRef: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const agents: Hono<ServerEnv> = new Hono<ServerEnv>();

/**
 * POST /api/agents/spawn
 *
 * Remote agent spawn request from a gossip peer.
 * Body: { role: string, command?: string, targetRef?: string, context?: Record<string, unknown> }
 *
 * Creates a claim for the delegated work. The peer's local TUI or
 * reconciler is responsible for picking up the claim and starting
 * an actual agent process (this endpoint only reserves the slot).
 */
agents.post("/spawn", zValidator("json", spawnBodySchema), async (c) => {
  const deps = c.get("deps");
  const claimStore = deps.claimStore;
  const topology = deps.topology;

  const body = c.req.valid("json");

  // Validate role against topology
  if (topology) {
    const validRole = topology.roles.find((r) => r.name === body.role);
    if (!validRole) {
      return c.json({ error: `unknown role: ${body.role}` }, 400);
    }
  }

  // Check capacity (use countActiveClaims to avoid materializing all claim objects)
  const activeCount = await claimStore.countActiveClaims();
  const maxSlots = 8; // Default; could be configurable
  if (activeCount >= maxSlots) {
    return c.json({ error: "at capacity", activeAgents: activeCount, maxSlots }, 503);
  }

  // Create a claim for the remote spawn
  const now = new Date();
  const agentId = `remote-${body.role}-${crypto.randomUUID().slice(0, 8)}`;
  const targetRef = body.targetRef ?? `delegated-${agentId}`;

  const claim = await claimStore.createClaim({
    claimId: crypto.randomUUID(),
    targetRef,
    agent: { agentId, role: body.role },
    status: "active",
    intentSummary: `Delegated spawn: ${body.role}`,
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 300_000).toISOString(),
    ...(body.context !== undefined
      ? {
          context: body.context as Readonly<
            Record<string, import("../../core/models.js").JsonValue>
          >,
        }
      : {}),
  });

  return c.json({
    claimId: claim.claimId,
    agentId,
    role: body.role,
    status: "spawned",
  });
});

/**
 * GET /api/agents/capacity
 *
 * Returns the current agent capacity for this server.
 * Used by gossip peers to determine delegation targets.
 */
agents.get("/capacity", async (c) => {
  const deps = c.get("deps");
  const claimStore = deps.claimStore;

  const activeCount = await claimStore.countActiveClaims();
  const maxSlots = 8;

  return c.json({
    totalSlots: maxSlots,
    usedSlots: activeCount,
    freeSlots: Math.max(0, maxSlots - activeCount),
  });
});
