/**
 * Artifact diff endpoint.
 *
 * GET /api/diff/:parentCid/:childCid/:artifactName — Fetch UTF-8 text of an
 * artifact from two contributions for client-side diffing.
 */

import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import type { ServerEnv } from "../deps.js";

const diff: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /api/diff/:parentCid/:childCid/:artifactName */
diff.get("/:parentCid/:childCid/:artifactName", async (c) => {
  const { contributionStore, cas } = c.get("deps");
  const parentCid = c.req.param("parentCid");
  const childCid = c.req.param("childCid");
  const artifactName = c.req.param("artifactName");

  // Look up parent contribution
  const parent = await contributionStore.get(parentCid);
  if (!parent) {
    return c.json(
      { error: { code: "NOT_FOUND", message: `Contribution ${parentCid} not found` } },
      404,
    );
  }

  // Look up child contribution
  const child = await contributionStore.get(childCid);
  if (!child) {
    return c.json(
      { error: { code: "NOT_FOUND", message: `Contribution ${childCid} not found` } },
      404,
    );
  }

  // Resolve artifact name to content hashes
  const parentHash = parent.artifacts[artifactName];
  if (!parentHash) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Artifact '${artifactName}' not found in ${parentCid}`,
        },
      },
      404,
    );
  }

  const childHash = child.artifacts[artifactName];
  if (!childHash) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Artifact '${artifactName}' not found in ${childCid}`,
        },
      },
      404,
    );
  }

  // Fetch both blobs from CAS
  const parentBlob = await cas.get(parentHash);
  if (!parentBlob) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Artifact blob not found for hash ${parentHash}`,
        },
      },
      404,
    );
  }

  const childBlob = await cas.get(childHash);
  if (!childBlob) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Artifact blob not found for hash ${childHash}`,
        },
      },
      404,
    );
  }

  const decoder = new TextDecoder();
  return c.json({
    parent: decoder.decode(parentBlob),
    child: decoder.decode(childBlob),
  });
});

export { diff };
