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
import { contributionStoreForSession } from "./shared.js";

const cidParamSchema = z.object({
  cid: z.string().regex(CID_REGEX, "CID must be in format blake3:<64-hex-chars>"),
});

const threadQuerySchema = z.object({
  maxDepth: z.coerce.number().int().min(0).max(100).default(50),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  sessionId: z.string().optional(),
});

const threadsQuerySchema = z.object({
  tags: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sessionId: z.string().optional(),
});

const threads: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /api/threads/:cid — View a discussion thread from its root. */
threads.get(
  "/:cid",
  zValidator("param", cidParamSchema),
  zValidator("query", threadQuerySchema),
  async (c) => {
    const { cid } = c.req.valid("param");
    const { maxDepth, limit, sessionId } = c.req.valid("query");

    // Use operation for validation (e.g., 404 on missing root)
    const serverDeps = c.get("deps");
    const contributionStore = contributionStoreForSession(serverDeps, sessionId);
    const deps = toOperationDeps({ ...serverDeps, contributionStore });
    const result = await threadOperation({ cid, maxDepth, limit }, deps);

    if (!result.ok) {
      const { data, status } = toHttpResult(result);
      return c.json(data, status);
    }

    // Return full thread nodes for HTTP consumers (TUI remote provider)
    const nodes = await contributionStore.thread(cid, { maxDepth, limit });
    return c.json({
      nodes: nodes.map((n) => ({
        cid: n.contribution.cid,
        depth: n.depth,
        contribution: n.contribution,
      })),
      count: nodes.length,
    });
  },
);

/** GET /api/threads — List active threads sorted by reply count. */
threads.get("/", zValidator("query", threadsQuerySchema), async (c) => {
  const raw = c.req.valid("query");

  const tags = raw.tags ? raw.tags.split(",").filter((t) => t.length > 0) : undefined;

  // Use operation for validation
  const serverDeps = c.get("deps");
  const contributionStore = contributionStoreForSession(serverDeps, raw.sessionId);
  const deps = toOperationDeps({ ...serverDeps, contributionStore });
  const result = await threadsOperation({ tags, limit: raw.limit }, deps);

  if (!result.ok) {
    const { data, status } = toHttpResult(result);
    return c.json(data, status);
  }

  // Return full thread summaries for HTTP consumers (TUI remote provider)
  const threadList = await contributionStore.hotThreads({ tags, limit: raw.limit });
  return c.json({
    threads: threadList.map((t) => ({
      cid: t.contribution.cid,
      replyCount: t.replyCount,
      lastReplyAt: t.lastReplyAt,
      contribution: t.contribution,
    })),
    count: threadList.length,
  });
});

export { threads };
