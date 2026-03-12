/**
 * Thread endpoints.
 *
 * GET /api/threads/:cid — View a discussion thread from its root
 * GET /api/threads       — List active threads sorted by reply count
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { threadOperation, threadsOperation } from "../../core/operations/index.js";
import type { ServerEnv } from "../deps.js";
import { toHttpResult, toOperationDeps } from "../operation-adapter.js";
import { CID_REGEX } from "../schemas.js";

const cidParamSchema = z.object({
  cid: z.string().regex(CID_REGEX, "CID must be in format blake3:<64-hex-chars>"),
});

const threadQuerySchema = z.object({
  maxDepth: z.coerce.number().int().min(0).max(100).default(50),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const threadsQuerySchema = z.object({
  tags: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const threads: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /api/threads/:cid — View a discussion thread from its root. */
threads.get(
  "/:cid",
  zValidator("param", cidParamSchema),
  zValidator("query", threadQuerySchema),
  async (c) => {
    const { cid } = c.req.valid("param");
    const { maxDepth, limit } = c.req.valid("query");

    const deps = toOperationDeps(c.get("deps"));
    const result = await threadOperation({ cid, maxDepth, limit }, deps);

    const { data, status } = toHttpResult(result);
    return c.json(data, status);
  },
);

/** GET /api/threads — List active threads sorted by reply count. */
threads.get("/", zValidator("query", threadsQuerySchema), async (c) => {
  const raw = c.req.valid("query");

  const tags = raw.tags ? raw.tags.split(",").filter((t) => t.length > 0) : undefined;

  const deps = toOperationDeps(c.get("deps"));
  const result = await threadsOperation({ tags, limit: raw.limit }, deps);

  const { data, status } = toHttpResult(result);
  return c.json(data, status);
});

export { threads };
