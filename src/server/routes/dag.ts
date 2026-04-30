/**
 * DAG traversal endpoints.
 *
 * GET /api/dag/:cid/children  — Contributions that reference this CID
 * GET /api/dag/:cid/ancestors — Contributions that this CID references
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "../deps.js";
import { CID_REGEX } from "../schemas.js";
import { contributionStoreForSession } from "./shared.js";

const cidParamSchema = z.object({
  cid: z.string().regex(CID_REGEX, "CID must be in format blake3:<64-hex-chars>"),
});

const sessionQuerySchema = z.object({
  sessionId: z.string().optional(),
});

const dag: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /api/dag/:cid/children — Incoming edges (who references this CID). */
dag.get(
  "/:cid/children",
  zValidator("param", cidParamSchema),
  zValidator("query", sessionQuerySchema),
  async (c) => {
    const { sessionId } = c.req.valid("query");
    const contributionStore = contributionStoreForSession(c.get("deps"), sessionId);
    const { cid } = c.req.valid("param");
    const children = await contributionStore.children(cid);
    return c.json(children);
  },
);

/** GET /api/dag/:cid/ancestors — Outgoing edge targets (who this CID references). */
dag.get(
  "/:cid/ancestors",
  zValidator("param", cidParamSchema),
  zValidator("query", sessionQuerySchema),
  async (c) => {
    const { sessionId } = c.req.valid("query");
    const contributionStore = contributionStoreForSession(c.get("deps"), sessionId);
    const { cid } = c.req.valid("param");
    const ancestors = await contributionStore.ancestors(cid);
    return c.json(ancestors);
  },
);

export { dag };
