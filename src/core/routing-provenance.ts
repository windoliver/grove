import { createHmac, timingSafeEqual } from "node:crypto";
import type { Contribution, ContributionInput, JsonValue, Relation, Score } from "./models.js";

export const ROUTING_SIGNATURE_CONTEXT_KEY = "_groveRoutingSig";

interface RoutingSignaturePayload {
  readonly kind: ContributionInput["kind"];
  readonly mode: ContributionInput["mode"];
  readonly summary: string;
  readonly description?: string | undefined;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly commitHash?: string | undefined;
  readonly relations: readonly Relation[];
  readonly scores?: Readonly<Record<string, Score>> | undefined;
  readonly tags: readonly string[];
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent: {
    readonly agentId: string;
    readonly role?: string | undefined;
  };
  readonly createdAt: string;
}

function stripRoutingSignature(
  context: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (context === undefined) return undefined;
  const next: Record<string, JsonValue> = { ...context };
  delete next[ROUTING_SIGNATURE_CONTEXT_KEY];
  return Object.keys(next).length > 0 ? next : undefined;
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function payloadFromInput(input: ContributionInput): RoutingSignaturePayload {
  return {
    kind: input.kind,
    mode: input.mode,
    summary: input.summary,
    description: input.description,
    artifacts: input.artifacts,
    commitHash: input.commitHash,
    relations: input.relations,
    scores: input.scores,
    tags: input.tags,
    context: stripRoutingSignature(input.context),
    agent: { agentId: input.agent.agentId, role: input.agent.role },
    createdAt: input.createdAt,
  };
}

function payloadFromContribution(contribution: Contribution): RoutingSignaturePayload {
  return {
    kind: contribution.kind,
    mode: contribution.mode,
    summary: contribution.summary,
    description: contribution.description,
    artifacts: contribution.artifacts,
    commitHash: contribution.commitHash,
    relations: contribution.relations,
    scores: contribution.scores,
    tags: contribution.tags,
    context: stripRoutingSignature(contribution.context),
    agent: { agentId: contribution.agent.agentId, role: contribution.agent.role },
    createdAt: contribution.createdAt,
  };
}

function signPayload(payload: RoutingSignaturePayload, routingToken: string): string {
  const canonical = JSON.stringify(canonicalize(payload));
  return createHmac("sha256", routingToken).update(canonical).digest("hex");
}

export function attachRoutingSignatureToInput(
  input: ContributionInput,
  routingToken: string,
): ContributionInput {
  const signature = signPayload(payloadFromInput(input), routingToken);
  return {
    ...input,
    context: {
      ...(stripRoutingSignature(input.context) ?? {}),
      [ROUTING_SIGNATURE_CONTEXT_KEY]: signature,
    },
  };
}

export function computeRoutingSignatureForContribution(
  contribution: Contribution,
  routingToken: string,
): string {
  return signPayload(payloadFromContribution(contribution), routingToken);
}

export function hasValidRoutingSignature(
  contribution: Contribution,
  routingToken: string,
): boolean {
  const observed = contribution.context?.[ROUTING_SIGNATURE_CONTEXT_KEY];
  if (typeof observed !== "string") return false;
  const expected = computeRoutingSignatureForContribution(contribution, routingToken);
  const observedBuf = Buffer.from(observed, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (observedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(observedBuf, expectedBuf);
}
