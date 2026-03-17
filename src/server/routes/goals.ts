/**
 * Goal endpoints.
 *
 * PUT /api/session/goal — Set (upsert) the current goal.
 * GET /api/session/goal — Get the current goal.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "../deps.js";
import { notConfigured } from "./shared.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const setGoalSchema = z.object({
  goal: z.string().min(1),
  acceptance: z.array(z.string().min(1)).default([]),
  setBy: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const goals: Hono<ServerEnv> = new Hono<ServerEnv>();

/** PUT /api/session/goal — Set (upsert) the current goal. */
goals.put("/goal", async (c) => {
  const { goalSessionStore } = c.get("deps");
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");

  const body = await c.req.json();
  const parsed = setGoalSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", details: parsed.error.issues } }, 400);
  }

  const { goal, acceptance, setBy } = parsed.data;
  const result = await goalSessionStore.setGoal(goal, acceptance, setBy ?? "operator");
  return c.json(result);
});

/** GET /api/session/goal — Get the current goal. */
goals.get("/goal", async (c) => {
  const { goalSessionStore } = c.get("deps");
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");

  const goalData = await goalSessionStore.getGoal();
  if (!goalData) {
    return c.json({ error: { code: "NOT_FOUND", message: "No goal has been set" } }, 404);
  }
  return c.json(goalData);
});
