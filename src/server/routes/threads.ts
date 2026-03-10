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
import type { ServerEnv } from "../deps.js";
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
    const { contributionStore } = c.get("deps");
    const { cid } = c.req.valid("param");
    const { maxDepth, limit } = c.req.valid("query");

    const nodes = await contributionStore.thread(cid, { maxDepth, limit });
    if (nodes.length === 0) {
      return c.json({ error: { code: "NOT_FOUND", message: `Thread root ${cid} not found` } }, 404);
    }

    return c.json(
      nodes.map((n) => ({
        cid: n.contribution.cid,
        depth: n.depth,
        contribution: n.contribution,
      })),
    );
  },
);

/** GET /api/threads — List active threads sorted by reply count. */
threads.get("/", zValidator("query", threadsQuerySchema), async (c) => {
  const { contributionStore } = c.get("deps");
  const raw = c.req.valid("query");

  const tags = raw.tags ? raw.tags.split(",").filter((t) => t.length > 0) : undefined;

  const results = await contributionStore.hotThreads({
    tags,
    limit: raw.limit,
  });

  return c.json(
    results.map((s) => ({
      cid: s.contribution.cid,
      replyCount: s.replyCount,
      lastReplyAt: s.lastReplyAt,
      contribution: s.contribution,
    })),
  );
});

export { threads };
