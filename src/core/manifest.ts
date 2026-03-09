/**
 * Manifest serialization and CID computation for contributions.
 *
 * - `computeCid()` produces a deterministic BLAKE3 hash of the canonical manifest.
 * - `toManifest()` serializes a Contribution to a plain JSON-safe object.
 * - `fromManifest()` validates and deserializes a manifest back to a Contribution.
 *
 * Canonical form follows RFC 8785 (JSON Canonicalization Scheme):
 * - Object keys are lexicographically sorted by Unicode code point.
 * - Numbers use ECMAScript serialization rules.
 * - No whitespace.
 * - `undefined` values are omitted (standard JSON.stringify behavior).
 *
 * The CID field is excluded from the hash input to avoid circular dependency.
 */

import { hash } from "blake3";
import { z } from "zod";

import type {
  AgentIdentity,
  Contribution,
  ContributionKind,
  ContributionMode,
  JsonValue,
  Relation,
  RelationType,
  Score,
  ScoreDirection,
} from "./models.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current manifest schema version. */
export const MANIFEST_VERSION = 1;

/** Prefix for BLAKE3 content-derived identifiers. */
const CID_PREFIX = "blake3:";

/** Regex pattern for valid CIDs: blake3:<64-hex-chars>. */
export const CID_PATTERN: RegExp = /^blake3:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// RFC 8785 — JSON Canonicalization Scheme (JCS)
// ---------------------------------------------------------------------------

/**
 * Canonical JSON serialization per RFC 8785.
 *
 * - Sorted object keys (Unicode code point order).
 * - ECMAScript number formatting.
 * - Rejects NaN and Infinity (not representable in JSON).
 * - Omits keys with `undefined` or `symbol` values.
 */
function canonicalize(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      throw new Error("NaN is not allowed in canonical JSON");
    }
    if (!Number.isFinite(value)) {
      throw new Error("Infinity is not allowed in canonical JSON");
    }
    return JSON.stringify(value);
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const v = item === undefined || typeof item === "symbol" ? null : item;
      return canonicalize(v);
    });
    return `[${items.join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .reduce<string[]>((acc, key) => {
      const v = obj[key];
      if (v !== undefined && typeof v !== "symbol") {
        acc.push(`${JSON.stringify(key)}:${canonicalize(v)}`);
      }
      return acc;
    }, []);
  return `{${entries.join(",")}}`;
}

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const ScoreDirectionSchema = z.enum(["minimize", "maximize"]);

const ContributionKindSchema = z.enum(["work", "review", "discussion", "adoption", "reproduction"]);

const ContributionModeSchema = z.enum(["evaluation", "exploration"]);

const RelationTypeSchema = z.enum([
  "derives_from",
  "responds_to",
  "reviews",
  "reproduces",
  "adopts",
]);

const AgentIdentitySchema = z
  .object({
    agentId: z.string().min(1),
    agentName: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    platform: z.string().optional(),
    version: z.string().optional(),
    toolchain: z.string().optional(),
    runtime: z.string().optional(),
  })
  .strict();

const ScoreSchema = z
  .object({
    value: z.number().refine((n) => Number.isFinite(n), { message: "Score value must be finite" }),
    direction: ScoreDirectionSchema,
    unit: z.string().optional(),
  })
  .strict();

const CidSchema = z
  .string()
  .regex(/^blake3:[0-9a-f]{64}$/, "CID must be in format blake3:<64-hex-chars>");

/**
 * Recursive schema for JSON-safe values only.
 * Rejects Date, Map, Set, class instances, functions, etc.
 */
const JsonValueSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.string(),
    z.number().refine((n) => Number.isFinite(n), { message: "JSON numbers must be finite" }),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const RelationSchema = z
  .object({
    targetCid: CidSchema,
    relationType: RelationTypeSchema,
    metadata: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();

/** Schema for ContributionInput — validates everything except cid and manifestVersion. */
const ContributionInputSchema = z
  .object({
    kind: ContributionKindSchema,
    mode: ContributionModeSchema,
    summary: z.string().min(1),
    description: z.string().optional(),
    artifacts: z.record(z.string(), z.string()),
    relations: z.array(RelationSchema),
    scores: z.record(z.string(), ScoreSchema).optional(),
    tags: z.array(z.string()),
    context: z.record(z.string(), JsonValueSchema).optional(),
    agent: AgentIdentitySchema,
    createdAt: z.string().datetime({ offset: true, message: "createdAt must be ISO 8601" }),
  })
  .strict();

const ContributionManifestSchema = z
  .object({
    cid: CidSchema,
    manifestVersion: z.number().int().positive(),
    kind: ContributionKindSchema,
    mode: ContributionModeSchema,
    summary: z.string().min(1),
    description: z.string().optional(),
    artifacts: z.record(z.string(), z.string()),
    relations: z.array(RelationSchema),
    scores: z.record(z.string(), ScoreSchema).optional(),
    tags: z.array(z.string()),
    context: z.record(z.string(), JsonValueSchema).optional(),
    agent: AgentIdentitySchema,
    createdAt: z.string().datetime({ offset: true, message: "createdAt must be ISO 8601" }),
  })
  .strict();

// ---------------------------------------------------------------------------
// Deep freeze utility
// ---------------------------------------------------------------------------

/** Recursively freeze an object and all nested objects/arrays. */
function deepFreeze<T>(obj: T): T {
  Object.freeze(obj);
  if (obj !== null && typeof obj === "object") {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        deepFreeze(value);
      }
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Input type for creating a contribution (everything except CID)
// ---------------------------------------------------------------------------

/** Input for creating a new contribution. CID is computed automatically. */
export type ContributionInput = Omit<Contribution, "cid" | "manifestVersion">;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the manifest dict (plain JSON-safe object) from a contribution,
 * excluding the CID field. This is the hash preimage.
 *
 * Undefined optional fields are omitted entirely (decision 6A).
 */
function toManifestDict(contribution: Contribution | ContributionInput): Record<string, unknown> {
  const agent: Record<string, unknown> = { agentId: contribution.agent.agentId };
  if (contribution.agent.agentName !== undefined) agent.agentName = contribution.agent.agentName;
  if (contribution.agent.provider !== undefined) agent.provider = contribution.agent.provider;
  if (contribution.agent.model !== undefined) agent.model = contribution.agent.model;
  if (contribution.agent.platform !== undefined) agent.platform = contribution.agent.platform;
  if (contribution.agent.version !== undefined) agent.version = contribution.agent.version;
  if (contribution.agent.toolchain !== undefined) agent.toolchain = contribution.agent.toolchain;
  if (contribution.agent.runtime !== undefined) agent.runtime = contribution.agent.runtime;

  const relations = contribution.relations.map((r) => {
    const rel: Record<string, unknown> = {
      targetCid: r.targetCid,
      relationType: r.relationType,
    };
    if (r.metadata !== undefined) rel.metadata = r.metadata;
    return rel;
  });

  const dict: Record<string, unknown> = {
    manifestVersion:
      "manifestVersion" in contribution
        ? (contribution as Contribution).manifestVersion
        : MANIFEST_VERSION,
    kind: contribution.kind,
    mode: contribution.mode,
    summary: contribution.summary,
    artifacts: contribution.artifacts,
    relations,
    tags: [...contribution.tags],
    agent,
    createdAt: contribution.createdAt,
  };

  if (contribution.description !== undefined) {
    dict.description = contribution.description;
  }
  if (contribution.scores !== undefined) {
    const scores: Record<string, unknown> = {};
    for (const [key, score] of Object.entries(contribution.scores)) {
      if (score !== undefined) {
        const s: Record<string, unknown> = {
          value: score.value,
          direction: score.direction,
        };
        if (score.unit !== undefined) s.unit = score.unit;
        scores[key] = s;
      }
    }
    dict.scores = scores;
  }
  if (contribution.context !== undefined) {
    dict.context = contribution.context;
  }

  return dict;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic content-derived identifier (CID) for a contribution.
 *
 * The CID is the BLAKE3 hash of the RFC 8785 canonical JSON serialization
 * of the manifest dict (excluding the CID field itself), prefixed with "blake3:".
 *
 * @param input - A contribution (CID field is ignored) or a ContributionInput.
 * @returns The CID string in the format "blake3:<64-char-hex>".
 */
export function computeCid(input: Contribution | ContributionInput): string {
  if ("cid" in input) {
    ContributionManifestSchema.parse(input);
  } else {
    ContributionInputSchema.parse(input);
  }
  const dict = toManifestDict(input);
  const canonical = canonicalize(dict);
  const bytes = new TextEncoder().encode(canonical);
  const digest = hash(bytes).toString("hex");
  return `${CID_PREFIX}${digest}`;
}

/**
 * Create a new Contribution with a computed CID.
 *
 * Returns a deeply frozen object. The CID is derived from the canonical
 * manifest, so two calls with identical input always produce the same CID.
 * All nested structures are deep-cloned to avoid freezing caller-owned objects.
 */
export function createContribution(input: ContributionInput): Contribution {
  ContributionInputSchema.parse(input);
  const cid = computeCid(input);
  const contribution: Contribution = {
    cid,
    manifestVersion: MANIFEST_VERSION,
    kind: input.kind,
    mode: input.mode,
    summary: input.summary,
    description: input.description,
    artifacts: { ...input.artifacts },
    relations: input.relations.map((r) => ({
      targetCid: r.targetCid,
      relationType: r.relationType,
      ...(r.metadata !== undefined && {
        metadata: JSON.parse(JSON.stringify(r.metadata)) as Readonly<Record<string, JsonValue>>,
      }),
    })),
    scores: input.scores
      ? Object.fromEntries(Object.entries(input.scores).map(([k, v]) => [k, v && { ...v }]))
      : undefined,
    tags: [...input.tags],
    context: input.context
      ? (JSON.parse(JSON.stringify(input.context)) as Readonly<Record<string, JsonValue>>)
      : undefined,
    agent: { ...input.agent },
    createdAt: input.createdAt,
  };
  return deepFreeze(contribution);
}

/**
 * Serialize a Contribution to a plain JSON-safe manifest dict.
 *
 * Optional fields that are `undefined` are omitted from the output.
 * The returned object can be safely passed to `JSON.stringify()`.
 */
export function toManifest(contribution: Contribution): Record<string, unknown> {
  const dict = toManifestDict(contribution);
  dict.cid = contribution.cid;
  return dict;
}

/** Options for `fromManifest()`. */
export interface FromManifestOptions {
  /** Verify CID integrity after deserialization. Defaults to `true`. */
  readonly verify?: boolean | undefined;
}

/**
 * Deserialize and validate a manifest dict into a Contribution.
 *
 * Uses Zod for strict validation. Throws a `ZodError` if the input is malformed.
 * Unknown fields are rejected (strict mode) to ensure CID integrity.
 * By default, verifies that the CID matches the content (set `verify: false` to skip).
 *
 * @param data - A plain object (e.g., parsed from JSON).
 * @param options - Optional settings. `verify` defaults to `true`.
 * @returns A frozen Contribution with validated fields.
 */
export function fromManifest(data: unknown, options?: FromManifestOptions): Contribution {
  const parsed = ContributionManifestSchema.parse(data);

  const agent: AgentIdentity = {
    agentId: parsed.agent.agentId,
    ...(parsed.agent.agentName !== undefined && { agentName: parsed.agent.agentName }),
    ...(parsed.agent.provider !== undefined && { provider: parsed.agent.provider }),
    ...(parsed.agent.model !== undefined && { model: parsed.agent.model }),
    ...(parsed.agent.platform !== undefined && { platform: parsed.agent.platform }),
    ...(parsed.agent.version !== undefined && { version: parsed.agent.version }),
    ...(parsed.agent.toolchain !== undefined && { toolchain: parsed.agent.toolchain }),
    ...(parsed.agent.runtime !== undefined && { runtime: parsed.agent.runtime }),
  };

  const relations: readonly Relation[] = parsed.relations.map((r) => ({
    targetCid: r.targetCid,
    relationType: r.relationType as RelationType,
    ...(r.metadata !== undefined && {
      metadata: r.metadata as Readonly<Record<string, JsonValue>>,
    }),
  }));

  const scores = parsed.scores
    ? Object.fromEntries(
        Object.entries(parsed.scores).map(([k, v]) => [
          k,
          {
            value: v.value,
            direction: v.direction as ScoreDirection,
            ...(v.unit !== undefined && { unit: v.unit }),
          } satisfies Score,
        ]),
      )
    : undefined;

  const contribution: Contribution = {
    cid: parsed.cid,
    manifestVersion: parsed.manifestVersion,
    kind: parsed.kind as ContributionKind,
    mode: parsed.mode as ContributionMode,
    summary: parsed.summary,
    ...(parsed.description !== undefined && { description: parsed.description }),
    artifacts: parsed.artifacts,
    relations,
    ...(scores !== undefined && { scores }),
    tags: parsed.tags,
    ...(parsed.context !== undefined && {
      context: parsed.context as Readonly<Record<string, JsonValue>>,
    }),
    agent,
    createdAt: parsed.createdAt,
  };

  const frozen = deepFreeze(contribution);

  if (options?.verify !== false && !verifyCid(frozen)) {
    const expected = computeCid(frozen);
    throw new Error(`CID integrity check failed: expected ${expected}, got ${frozen.cid}`);
  }

  return frozen;
}

/**
 * Verify that a Contribution's CID matches its content.
 *
 * @returns `true` if the CID is valid, `false` otherwise.
 */
export function verifyCid(contribution: Contribution): boolean {
  return computeCid(contribution) === contribution.cid;
}

// Schemas are kept module-private. Downstream consumers should use
// fromManifest() for validation. If raw schemas are needed later,
// they can be moved to a dedicated schemas.ts with explicit type annotations
// (required by isolatedDeclarations).
