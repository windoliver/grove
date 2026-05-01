/**
 * Content-hash helpers for retry-safe store-boundary deduplication.
 *
 * These hashes intentionally exclude generated identifiers and timestamps.
 * They represent the caller's logical payload, not the persisted row identity.
 */

import { createHash } from "node:crypto";
import type { Bounty } from "./bounty.js";
import type { Contribution } from "./models.js";
import type { OutcomeInput, OutcomeRecord } from "./outcome.js";

const BOUNTY_CONTENT_HASH_PROPERTY = "__groveContentHash";

type BountyWithProvidedContentHash = Bounty & {
  readonly [BOUNTY_CONTENT_HASH_PROPERTY]?: string | undefined;
};

function canonicalize(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw new Error("NaN is not allowed in canonical JSON");
    if (!Number.isFinite(value)) throw new Error("Infinity is not allowed in canonical JSON");
    return JSON.stringify(value);
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item === undefined ? null : item)).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .reduce<string[]>((acc, key) => {
      const item = obj[key];
      if (item !== undefined && typeof item !== "symbol") {
        acc.push(`${JSON.stringify(key)}:${canonicalize(item)}`);
      }
      return acc;
    }, []);
  return `{${entries.join(",")}}`;
}

function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function sortedTags(tags: readonly string[]): readonly string[] {
  return [...tags].sort();
}

function sortedRelations(contribution: Contribution): readonly unknown[] {
  return [...contribution.relations]
    .map((relation) => ({
      targetCid: relation.targetCid,
      relationType: relation.relationType,
      metadata: relation.metadata,
    }))
    .sort((a, b) => {
      if (a.targetCid !== b.targetCid) return a.targetCid < b.targetCid ? -1 : 1;
      if (a.relationType !== b.relationType) return a.relationType < b.relationType ? -1 : 1;
      const aMeta = canonicalize(a.metadata ?? null);
      const bMeta = canonicalize(b.metadata ?? null);
      return aMeta < bMeta ? -1 : aMeta > bMeta ? 1 : 0;
    });
}

/** Compute the implicit dedup key for a contribution payload. */
export function computeContributionContentHash(contribution: Contribution): string {
  return sha256Canonical({
    entity: "contribution",
    user: contribution.agent.agentId,
    category: contribution.kind,
    payload: {
      mode: contribution.mode,
      summary: contribution.summary,
      description: contribution.description,
      artifacts: contribution.artifacts,
      commitHash: contribution.commitHash,
      relations: sortedRelations(contribution),
      scores: contribution.scores,
      tags: sortedTags(contribution.tags),
      context: contribution.context,
    },
  });
}

/** Compute the implicit dedup key for a bounty create payload. */
export function computeBountyContentHash(bounty: Bounty): string {
  return sha256Canonical({
    entity: "bounty",
    user: bounty.creator.agentId,
    category: "bounty",
    payload: {
      title: bounty.title,
      description: bounty.description,
      amount: bounty.amount,
      criteria: bounty.criteria,
      zoneId: bounty.zoneId,
      context: bounty.context,
    },
  });
}

/** Attach a non-serialized bounty create payload hash for store-boundary deduplication. */
export function withBountyContentHash(
  bounty: Bounty,
  contentHash: string = computeBountyContentHash(bounty),
): Bounty {
  const marked = { ...bounty };
  Object.defineProperty(marked, BOUNTY_CONTENT_HASH_PROPERTY, {
    value: contentHash,
    enumerable: false,
  });
  return marked;
}

function computeBountyRecordContentHash(bounty: Bounty): string {
  return sha256Canonical({
    entity: "bounty-record",
    bountyId: bounty.bountyId,
    logicalHash: computeBountyContentHash(bounty),
  });
}

/** Compute the hash stored by bounty backends, honoring operation-level dedup hints. */
export function computeBountyStorageContentHash(bounty: Bounty): string {
  return (
    (bounty as BountyWithProvidedContentHash)[BOUNTY_CONTENT_HASH_PROPERTY] ??
    computeBountyRecordContentHash(bounty)
  );
}

/** Compute the implicit dedup key for an outcome set payload. */
export function computeOutcomeContentHash(
  cid: string,
  input: OutcomeInput | OutcomeRecord,
): string {
  return sha256Canonical({
    entity: "outcome",
    user: input.evaluatedBy,
    category: "outcome",
    payload: {
      cid,
      status: input.status,
      reason: input.reason,
      baselineCid: input.baselineCid,
    },
  });
}
