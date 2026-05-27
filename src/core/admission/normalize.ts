import type { Gate, GroveContract } from "../contract.js";
import { hookCommand, hookTimeout } from "../hooks.js";
import type { NormalizedAdmissionRule } from "./types.js";

const LegacyHookTimeoutMs = 300_000;

interface LegacyGateCandidate {
  readonly rule: NormalizedAdmissionRule;
  readonly semanticIdentity: string;
}

export function normalizeAdmissionRules(
  contract: GroveContract | undefined,
): readonly NormalizedAdmissionRule[] {
  if (contract === undefined) return [];

  const rules: NormalizedAdmissionRule[] = [];
  const occupiedNames = new Set<string>();
  const explicitOrHookNames = new Set<string>();
  const legacyGateNamesBySemanticIdentity = new Map<string, Map<string, string>>();

  for (const rule of contract.admission ?? []) {
    rules.push({ ...rule, source: "explicit" });
    occupiedNames.add(rule.name);
    explicitOrHookNames.add(rule.name);
  }

  const beforeContribute = contract.hooks?.before_contribute;
  if (beforeContribute !== undefined && !occupiedNames.has("before_contribute")) {
    rules.push({
      type: "shell",
      name: "before_contribute",
      command: hookCommand(beforeContribute),
      timeout: hookTimeout(beforeContribute, LegacyHookTimeoutMs),
      onFail: "reject",
      source: "legacy_hook",
    });
    occupiedNames.add("before_contribute");
    explicitOrHookNames.add("before_contribute");
  }

  for (const gate of contract.gates ?? []) {
    const candidate = admissionRuleFromGate(gate);
    if (candidate === undefined || explicitOrHookNames.has(candidate.rule.name)) {
      continue;
    }

    let namesBySemanticIdentity = legacyGateNamesBySemanticIdentity.get(candidate.rule.name);
    if (namesBySemanticIdentity === undefined) {
      namesBySemanticIdentity = new Map<string, string>();
      legacyGateNamesBySemanticIdentity.set(candidate.rule.name, namesBySemanticIdentity);
    }
    if (namesBySemanticIdentity.has(candidate.semanticIdentity)) {
      continue;
    }

    const name =
      namesBySemanticIdentity.size === 0 && !occupiedNames.has(candidate.rule.name)
        ? candidate.rule.name
        : uniqueLegacyGateName(candidate.rule.name, candidate.semanticIdentity, occupiedNames);

    rules.push({ ...candidate.rule, name });
    occupiedNames.add(name);
    namesBySemanticIdentity.set(candidate.semanticIdentity, name);
  }

  return rules;
}

function admissionRuleFromGate(gate: Gate): LegacyGateCandidate | undefined {
  switch (gate.type) {
    case "metric_improves":
      if (gate.metric === undefined) return undefined;
      return {
        rule: {
          type: "metric_improves",
          name: `gate_metric_improves_${safeNamePart(gate.metric)}`,
          metric: gate.metric,
          source: "legacy_gate",
        },
        semanticIdentity: `metric_improves:${gate.metric}`,
      };
    case "has_artifact":
      if (gate.name === undefined) return undefined;
      return {
        rule: {
          type: "artifact_required",
          name: `gate_has_artifact_${safeNamePart(gate.name)}`,
          artifact: gate.name,
          source: "legacy_gate",
        },
        semanticIdentity: `has_artifact:${gate.name}`,
      };
    case "has_relation":
      if (gate.relationType === undefined) return undefined;
      return {
        rule: {
          type: "relation_required",
          name: `gate_has_relation_${safeNamePart(gate.relationType)}`,
          relationType: gate.relationType,
          source: "legacy_gate",
        },
        semanticIdentity: `has_relation:${gate.relationType}`,
      };
    case "min_score":
      if (gate.metric === undefined || gate.threshold === undefined) return undefined;
      return {
        rule: {
          type: "metric_check",
          name: `gate_min_score_${safeNamePart(gate.metric)}`,
          metric: gate.metric,
          minValue: gate.threshold,
          source: "legacy_gate",
        },
        semanticIdentity: `min_score:${gate.metric}:${gate.threshold}`,
      };
    case "min_reviews":
      return undefined;
  }
}

function uniqueLegacyGateName(
  baseName: string,
  semanticIdentity: string,
  occupiedNames: ReadonlySet<string>,
): string {
  const candidate = `${baseName}_${stableNameSuffix(semanticIdentity)}`;
  if (!occupiedNames.has(candidate)) return candidate;

  let counter = 2;
  while (occupiedNames.has(`${candidate}_${counter}`)) {
    counter += 1;
  }
  return `${candidate}_${counter}`;
}

function stableNameSuffix(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}

function safeNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}
