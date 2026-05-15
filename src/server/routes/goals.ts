/**
 * Goal endpoints.
 *
 * PUT /api/session/goal — Set (upsert) the current goal.
 * GET /api/session/goal — Get the current goal.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "../deps.js";
import { dangerous, getIfMatch } from "../middleware/dangerous.js";
import { notConfigured, readJsonBody } from "./shared.js";

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

/**
 * PUT /api/session/goal — Set (upsert) the current goal.
 *
 * @Dangerous: wrapped with `dangerous()` middleware. Requests without an
 * `If-Match` header are rejected with `428 Precondition Required` before
 * the handler runs. A stale If-Match returns `409 Conflict` with the
 * store's current goal RV. The store's `setGoal` treats `ifMatch` as a
 * no-op on the first insert (no row to compare against).
 */
goals.put(
  "/goal",
  dangerous<"/goal">(async (c) => {
    const { goalSessionStore } = c.get("deps");
    if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");

    const json = await readJsonBody(c);
    if (!json.ok) return json.response;

    const parsed = setGoalSchema.safeParse(json.body);
    if (!parsed.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", details: parsed.error.issues } }, 400);
    }

    const { goal, acceptance, setBy } = parsed.data;
    const ifMatch = getIfMatch(c);
    const goalResult = await goalSessionStore.setGoal(goal, acceptance, setBy ?? "operator", {
      ifMatch,
    });
    if (goalResult.kind === "rv-mismatch") {
      return c.json(
        {
          error: {
            code: "CONFLICT",
            message: "Goal resourceVersion changed",
            current: goalResult.current,
          },
        },
        409,
      );
    }
    return c.json(goalResult.view);
  }),
);

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
