/**
 * Timeline HTTP endpoints.
 *
 * GET /api/timeline                  - list timeline events and current RV
 * GET /api/timeline/events/:eventId  - fetch one timeline event
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "../deps.js";
import { notConfigured } from "./shared.js";

const booleanQuerySchema = z
  .union([z.literal("true"), z.literal("false"), z.boolean()])
  .transform((value) => value === true || value === "true")
  .optional();

const timelineQuerySchema = z.object({
  sessionId: z.string().optional(),
  afterRv: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  workBlockId: z.string().optional(),
  includeWorkBlocks: booleanQuerySchema,
});

export const timeline: HonoType<ServerEnv> = new Hono<ServerEnv>();

timeline.get("/timeline", zValidator("query", timelineQuerySchema), async (c) => {
  const store = c.get("deps").timelineStore;
  if (store === undefined) return notConfigured(c, "timelineStore is not configured");
  const query = c.req.valid("query");
  const events = await store.listTimelineEvents(query);
  const workBlocks =
    query.includeWorkBlocks === true
      ? await store.listWorkBlocks({ sessionId: query.sessionId })
      : undefined;

  return c.json({
    sessionId: query.sessionId,
    events,
    ...(workBlocks === undefined ? {} : { workBlocks }),
    timelineResourceVersion: await store.currentTimelineResourceVersion(query.sessionId),
  });
});

timeline.get("/timeline/events/:eventId", async (c) => {
  const store = c.get("deps").timelineStore;
  if (store === undefined) return notConfigured(c, "timelineStore is not configured");
  const event = await store.getTimelineEvent(c.req.param("eventId"));
  if (event === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "TimelineEvent not found" } }, 404);
  }
  return c.json(event);
});
