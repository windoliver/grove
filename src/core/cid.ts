/**
 * Content-derived identifier (CID) computation for Grove contributions.
 *
 * CID = blake3:<hex64> where the hash is computed over the RFC 8785 (JCS)
 * canonical JSON serialization of the manifest, excluding the `cid` field.
 *
 * The wire format uses snake_case keys. The canonical serialization
 * converts from camelCase TypeScript fields to snake_case before hashing.
 */

import { hash } from "blake3";
import { canonicalize } from "json-canonicalize";
import type {
  AgentIdentity,
  Contribution,
  ContributionInput,
  JsonValue,
  Relation,
  Score,
} from "./models.js";

/** CID prefix identifying the hash algorithm. */
const CID_PREFIX = "blake3:";

/** Recursively freeze an object and all its nested objects. */
function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

/**
 * Normalize a JSON value to its canonical equivalent.
 *
 * Round-trips through JSON.parse(JSON.stringify(...)) to ensure the hash
 * input matches what JSON serialization would produce. This handles:
 * - NaN → null, Infinity / -Infinity → null (valid numbers in JS, not in JSON)
 * - undefined keys are dropped
 *
 * The JsonValue type prevents structurally non-JSON types (Map, Set,
 * BigInt, functions, symbols) at compile time. This function handles
 * the remaining numeric edge cases at runtime.
 */
function jsonNormalize(value: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

/**
 * Normalize an RFC 3339 timestamp to UTC with Z suffix.
 * Ensures that equivalent instants (e.g. "10:00:00+05:30" and "04:30:00Z")
 * produce the same canonical form and therefore the same CID.
 */
function normalizeTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid timestamp: ${timestamp}`);
  }
  return date.toISOString();
}

/**
 * Convert a camelCase AgentIdentity to snake_case wire format.
 */
function agentToWire(agent: AgentIdentity): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    agent_name: agent.agentName,
  };
  if (agent.agentId !== undefined) wire.agent_id = agent.agentId;
  if (agent.provider !== undefined) wire.provider = agent.provider;
  if (agent.model !== undefined) wire.model = agent.model;
  if (agent.version !== undefined) wire.version = agent.version;
  if (agent.toolchain !== undefined) wire.toolchain = agent.toolchain;
  if (agent.runtime !== undefined) wire.runtime = agent.runtime;
  if (agent.platform !== undefined) wire.platform = agent.platform;
  return wire;
}

/**
 * Convert a camelCase Score to snake_case wire format.
 * Throws if the score value is not finite (NaN, Infinity, -Infinity).
 */
function scoreToWire(score: Score): Record<string, unknown> {
  if (!Number.isFinite(score.value)) {
    throw new RangeError(`Score value must be finite, got ${score.value}`);
  }
  const wire: Record<string, unknown> = {
    value: score.value,
    direction: score.direction,
  };
  if (score.unit !== undefined) wire.unit = score.unit;
  return wire;
}

/**
 * Convert a camelCase Relation to snake_case wire format.
 * Normalizes metadata through JSON round-trip for hash consistency.
 */
function relationToWire(relation: Relation): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    target_cid: relation.targetCid,
    relation_type: relation.relationType,
  };
  if (relation.metadata !== undefined) {
    wire.metadata = jsonNormalize(relation.metadata);
  }
  return wire;
}

/**
 * Convert camelCase scores map to snake_case wire format.
 */
function scoresToWire(
  scores: Readonly<Record<string, Score>> | undefined,
): Record<string, unknown> | undefined {
  if (scores === undefined) return undefined;
  const wire: Record<string, unknown> = {};
  for (const [key, score] of Object.entries(scores)) {
    wire[key] = scoreToWire(score);
  }
  return wire;
}

/**
 * Convert a ContributionInput to the snake_case wire format object
 * used for canonical serialization. Excludes the `cid` field.
 *
 * Normalizes timestamps to UTC and strips undefined values from
 * context/metadata to ensure consistent CID computation.
 */
export function toWireFormat(input: ContributionInput): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    kind: input.kind,
    mode: input.mode,
    summary: input.summary,
    artifacts: input.artifacts,
    relations: input.relations.map(relationToWire),
    tags: [...input.tags].sort(),
    agent: agentToWire(input.agent),
    created_at: normalizeTimestamp(input.createdAt),
  };
  if (input.description !== undefined) wire.description = input.description;
  if (input.scores !== undefined) wire.scores = scoresToWire(input.scores);
  if (input.context !== undefined) {
    wire.context = jsonNormalize(input.context);
  }
  return wire;
}

/**
 * Compute the CID for a contribution manifest.
 *
 * Converts the input to snake_case wire format, serializes with RFC 8785
 * canonical JSON, and hashes with BLAKE3.
 *
 * @param input - The contribution fields (everything except cid)
 * @returns CID string in format `blake3:<hex64>`
 */
export function computeCid(input: ContributionInput): string {
  const wire = toWireFormat(input);
  const canonical = canonicalize(wire);
  const digest = hash(canonical);
  return `${CID_PREFIX}${Buffer.from(digest).toString("hex")}`;
}

/**
 * Create an immutable Contribution from input fields.
 *
 * Computes the CID automatically from the canonical serialization
 * and returns a deeply frozen Contribution object.
 *
 * @param input - The contribution fields (everything except cid)
 * @returns A deeply frozen Contribution with computed CID
 */
export function createContribution(input: ContributionInput): Contribution {
  const cid = computeCid(input);
  const contribution: Contribution = {
    cid,
    ...structuredClone(input),
  };
  return deepFreeze(contribution);
}

/**
 * Verify that a contribution's CID matches its content.
 *
 * Returns false for both tampered content and malformed input
 * (e.g., non-finite score values). Never throws.
 *
 * @param contribution - The contribution to verify
 * @returns true if the CID is valid
 */
export function verifyCid(contribution: Contribution): boolean {
  try {
    const { cid: _cid, ...rest } = contribution;
    const input: ContributionInput = rest;
    return computeCid(input) === contribution.cid;
  } catch {
    return false;
  }
}
