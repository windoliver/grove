/**
 * WorkBlock HTTP endpoints.
 *
 * POST  /api/work-blocks      - create or replace a WorkBlock
 * PATCH /api/work-blocks/:id  - patch controller/user-owned mutable fields
 * GET   /api/work-blocks      - list WorkBlocks
 * GET   /api/work-blocks/:id  - fetch a WorkBlock
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { workBlockToEntity } from "../../core/entity.js";
import { NotFoundError } from "../../core/errors.js";
import {
  type ResourceRef,
  type WorkBlock,
  WorkBlockStatus,
  type WorkBlockStatus as WorkBlockStatusType,
} from "../../core/timeline.js";
import { WorkBlockSchema } from "../../core/timeline-schemas.js";
import type { WorkBlockPatch } from "../../core/timeline-store.js";
import type { EntityWriteEvent } from "../../core/watch-events.js";
import type { ServerEnv } from "../deps.js";
import { notConfigured } from "./shared.js";

const statusValues = Object.values(WorkBlockStatus) as [
  WorkBlockStatusType,
  ...WorkBlockStatusType[],
];

const resourceRefSchema: z.ZodType<ResourceRef> = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1),
    label: z.string().optional(),
    href: z.string().optional(),
  })
  .strict();

const costSummaryPatchSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    model: z.string().optional(),
  })
  .strict();

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const patchSchema = z
  .object({
    status: z.enum(statusValues).optional(),
    startedAt: z.string().datetime({ offset: true }).optional(),
    completedAt: z.string().datetime({ offset: true }).optional(),
    inputRefs: z.array(resourceRefSchema).optional(),
    outputRefs: z.array(resourceRefSchema).optional(),
    evidenceRefs: z.array(resourceRefSchema).optional(),
    approvalRefs: z.array(resourceRefSchema).optional(),
    contributionCids: z.array(z.string()).optional(),
    artifactHashes: z.array(z.string()).optional(),
    claimIds: z.array(z.string()).optional(),
    costSummary: costSummaryPatchSchema.optional(),
    links: z.array(resourceRefSchema).optional(),
    context: z.record(z.string(), jsonValueSchema).optional(),
  })
  .strict();

const listQuerySchema = z.object({
  sessionId: z.string().optional(),
  actorId: z.string().optional(),
  status: z.enum(statusValues).optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const workBlocks: HonoType<ServerEnv> = new Hono<ServerEnv>();

workBlocks.get("/work-blocks", zValidator("query", listQuerySchema), async (c) => {
  const store = c.get("deps").timelineStore;
  if (store === undefined) return notConfigured(c, "timelineStore is not configured");
  const query = c.req.valid("query");
  const items = await store.listWorkBlocks(query);
  return c.json({ items });
});

workBlocks.get("/work-blocks/:id", async (c) => {
  const store = c.get("deps").timelineStore;
  if (store === undefined) return notConfigured(c, "timelineStore is not configured");
  const block = await store.getWorkBlock(c.req.param("id"));
  if (block === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "WorkBlock not found" } }, 404);
  }
  return c.json(block);
});

workBlocks.post("/work-blocks", zValidator("json", WorkBlockSchema), async (c) => {
  const deps = c.get("deps");
  const store = deps.timelineStore;
  if (store === undefined) return notConfigured(c, "timelineStore is not configured");
  const namespace = c.get("namespace");
  const input = c.req.valid("json");
  const existing = await store.getWorkBlock(input.workBlockId);
  const block = await store.putWorkBlock(input);
  recordWorkBlockWrite(deps, namespace, existing === undefined ? "ADDED" : "MODIFIED", block);
  return c.json(block, 201);
});

workBlocks.patch("/work-blocks/:id", zValidator("json", patchSchema), async (c) => {
  const deps = c.get("deps");
  const store = deps.timelineStore;
  if (store === undefined) return notConfigured(c, "timelineStore is not configured");
  try {
    const block = await store.patchWorkBlock(
      c.req.param("id"),
      c.req.valid("json") as WorkBlockPatch,
    );
    recordWorkBlockWrite(deps, c.get("namespace"), "MODIFIED", block);
    return c.json(block);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: { code: "NOT_FOUND", message: "WorkBlock not found" } }, 404);
    }
    throw error;
  }
});

function recordWorkBlockWrite(
  deps: ServerEnv["Variables"]["deps"],
  namespace: string,
  op: EntityWriteEvent["op"],
  block: WorkBlock,
): void {
  const entity = workBlockToEntity(block, namespace);
  deps.watchHub.recordWrite({ kind: "WorkBlock", namespace, op, entity });
  deps.watchSubscriber?.markSeen({
    kind: "WorkBlock",
    entityId: block.workBlockId,
    generation: entity.metadata.generation,
  });
}
