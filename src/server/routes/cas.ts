/**
 * Content-addressable storage endpoints (read-only, peer-to-peer replication).
 *
 * GET /api/cas/:hash       — Download blob by BLAKE3 content hash.
 * GET /api/cas/:hash/meta  — Return size + mediaType without the body.
 *
 * Writes go through `POST /api/contributions` (multipart). This route is the
 * fetch side used by gossip federation (#226).
 */

import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import { CID_REGEX } from "../../core/constants.js";
import type { ServerEnv } from "../deps.js";

const cas: HonoType<ServerEnv> = new Hono<ServerEnv>();

cas.get("/:hash/meta", async (c) => {
  const hash = c.req.param("hash");
  if (!CID_REGEX.test(hash)) {
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Hash must be blake3:<64-hex>" } },
      400,
    );
  }
  const { cas: store } = c.get("deps");
  const meta = await store.stat(hash);
  if (!meta) {
    return c.json({ error: { code: "NOT_FOUND", message: `Blob ${hash} not found` } }, 404);
  }
  return c.json({
    sizeBytes: meta.sizeBytes,
    ...(meta.mediaType !== undefined ? { mediaType: meta.mediaType } : {}),
  });
});

cas.get("/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!CID_REGEX.test(hash)) {
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Hash must be blake3:<64-hex>" } },
      400,
    );
  }
  const { cas: store } = c.get("deps");
  const data = await store.get(hash);
  if (!data) {
    return c.json({ error: { code: "NOT_FOUND", message: `Blob ${hash} not found` } }, 404);
  }
  const meta = await store.stat(hash);
  return new Response(data, {
    status: 200,
    headers: {
      "Content-Type": meta?.mediaType ?? "application/octet-stream",
      "Content-Length": String(data.byteLength),
    },
  });
});

export { cas };
