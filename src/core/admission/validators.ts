import type { Contribution, JsonValue } from "../models.js";
import type { PolicyViolation } from "../policy-enforcer.js";
import { PolicyEnforcer } from "../policy-enforcer.js";
import type { SessionRuntimeConfig } from "../session-config.js";
import { AdmissionRejectError } from "./errors.js";
import {
  type AdmissionAttributes,
  AdmissionOp,
  type AdmissionValidator,
  hookEntryFromShellRule,
  type NormalizedAdmissionRule,
} from "./types.js";

const MaxEvidenceTextLength = 4096;
const PendingAdmissionCid =
  "blake3:0000000000000000000000000000000000000000000000000000000000000000";

export function createAdmissionValidators(
  rules: readonly NormalizedAdmissionRule[],
): readonly AdmissionValidator[] {
  return rules.map((rule) => ({
    name: rule.name,
    ruleType: rule.type,
    handles: (op) => op === AdmissionOp.Contribute,
    validate: async (attrs) => validateRule(rule, attrs),
  }));
}

async function validateRule(
  rule: NormalizedAdmissionRule,
  attrs: AdmissionAttributes,
): Promise<void> {
  switch (rule.type) {
    case "shell":
      return validateShell(rule, attrs);
    case "metric_check":
      return validateMetricCheck(rule, attrs);
    case "artifact_required":
      return validateArtifactRequired(rule, attrs);
    case "relation_required":
      return validateRelationRequired(rule, attrs);
    case "metric_improves":
      return validateMetricImproves(rule, attrs);
    case "blueprint_hash":
      return validateBlueprintHash(rule, attrs);
    case "artifact_signature":
      return validateArtifactSignature(rule, attrs);
    case "rebac_permission":
      return validateRebacPermission(rule, attrs);
    case "governance_policy":
      return validateGovernancePolicy(rule, attrs);
  }
}

async function validateShell(
  rule: Extract<NormalizedAdmissionRule, { readonly type: "shell" }>,
  attrs: AdmissionAttributes,
): Promise<void> {
  const hookRunner = attrs.deps.hookRunner;
  if (hookRunner === undefined) {
    reject(rule, "hook runner is not configured");
  }

  const hookCwd = attrs.deps.hookCwd;
  if (hookCwd === undefined) {
    reject(rule, "hook working directory is not configured");
  }

  const result = await hookRunner.run(hookEntryFromShellRule(rule), hookCwd);
  attrs.annotations.set(`admission.shell.${rule.name}.exit_code`, String(result.exitCode));
  attrs.annotations.set(`admission.shell.${rule.name}.duration_ms`, String(result.durationMs));

  if (!result.success && rule.onFail !== "warn") {
    const stdout = truncateEvidenceText(result.stdout);
    const stderr = truncateEvidenceText(result.stderr);
    reject(rule, "shell command failed", {
      command: result.command,
      exit_code: result.exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
    });
  }
}

function validateMetricCheck(
  rule: Extract<NormalizedAdmissionRule, { readonly type: "metric_check" }>,
  attrs: AdmissionAttributes,
): void {
  const value = attrs.object.scores?.[rule.metric]?.value;
  if (value === undefined) {
    reject(rule, `missing metric '${rule.metric}'`, { metric: rule.metric });
  }

  if (rule.minValue !== undefined && value < rule.minValue) {
    reject(rule, `metric '${rule.metric}' is below minimum`, {
      metric: rule.metric,
      value,
      min_value: rule.minValue,
    });
  }

  if (rule.maxValue !== undefined && value > rule.maxValue) {
    reject(rule, `metric '${rule.metric}' is above maximum`, {
      metric: rule.metric,
      value,
      max_value: rule.maxValue,
    });
  }

  attrs.annotations.set(`admission.metric.${rule.name}.value`, String(value));
}

function validateArtifactRequired(
  rule: Extract<NormalizedAdmissionRule, { readonly type: "artifact_required" }>,
  attrs: AdmissionAttributes,
): void {
  if (attrs.object.artifacts[rule.artifact] !== undefined) {
    return;
  }

  reject(rule, `missing artifact '${rule.artifact}'`, {
    artifact: rule.artifact,
    present_artifacts: Object.keys(attrs.object.artifacts),
  });
}

function validateRelationRequired(
  rule: Extract<NormalizedAdmissionRule, { readonly type: "relation_required" }>,
  attrs: AdmissionAttributes,
): void {
  if (attrs.object.relations.some((relation) => relation.relationType === rule.relationType)) {
    return;
  }

  reject(rule, `missing relation '${rule.relationType}'`, {
    relation_type: rule.relationType,
    present_relation_types: uniqueStrings(
      attrs.object.relations.map((relation) => relation.relationType),
    ),
  });
}

async function validateMetricImproves(
  rule: Extract<NormalizedAdmissionRule, { readonly type: "metric_improves" }>,
  attrs: AdmissionAttributes,
): Promise<void> {
  if (attrs.contract === undefined || attrs.deps.contributionStore === undefined) {
    reject(rule, "metric_improves requires contract and contribution store");
  }

  const config: SessionRuntimeConfig = {
    mode: attrs.contract.mode,
    metrics: attrs.contract.metrics,
    gates: [{ type: "metric_improves", metric: rule.metric }],
  };
  const contribution: Contribution = {
    cid: PendingAdmissionCid,
    manifestVersion: 1,
    ...attrs.object,
  };
  const enforcer = new PolicyEnforcer(config, attrs.deps.contributionStore);
  const result = await enforcer.enforce(contribution, false);
  const violation = result.violations.find((candidate) =>
    isMetricImprovesViolation(candidate, rule.metric),
  );

  if (violation !== undefined) {
    reject(rule, violation.message, jsonRecordFromUnknown(violation.details));
  }
}

async function validateBlueprintHash(
  rule: Extract<NormalizedAdmissionRule, { readonly type: "blueprint_hash" }>,
  attrs: AdmissionAttributes,
): Promise<void> {
  const source = attrs.deps.blueprintHashSource;
  if (source === undefined) {
    reject(rule, "blueprint hash source is not configured");
  }

  const observedHash = await runDelegate(rule, "blueprint hash source failed", async () =>
    source.hash(rule.blueprint),
  );
  if (observedHash === undefined) {
    reject(rule, "blueprint not found", { blueprint: rule.blueprint });
  }

  const contextHash = attrs.object.context?.blueprint_hash;
  const expectedHash =
    rule.expectedHash ?? (typeof contextHash === "string" ? contextHash : undefined);
  if (expectedHash === undefined) {
    reject(rule, "expected blueprint hash is missing", { blueprint: rule.blueprint });
  }

  if (observedHash !== expectedHash) {
    reject(rule, "blueprint hash mismatch", {
      blueprint: rule.blueprint,
      observed_hash: observedHash,
      expected_hash: expectedHash,
    });
  }
}

async function validateArtifactSignature(
  rule: Extract<NormalizedAdmissionRule, { readonly type: "artifact_signature" }>,
  attrs: AdmissionAttributes,
): Promise<void> {
  if (rule.artifact !== undefined && attrs.object.artifacts[rule.artifact] === undefined) {
    reject(rule, `missing artifact '${rule.artifact}' for signature verification`, {
      artifact: rule.artifact,
      present_artifacts: Object.keys(attrs.object.artifacts),
    });
  }

  const verifier = attrs.deps.artifactSignatureVerifier;
  if (verifier === undefined) {
    reject(rule, "artifact signature verifier is not configured");
  }

  const result = await runDelegate(rule, "artifact signature verifier failed", async () =>
    verifier.verify({
      artifactName: rule.artifact,
      artifactHashes: attrs.object.artifacts,
      context: attrs.object.context,
      requireSignerIn: rule.requireSignerIn,
    }),
  );
  if (!result.accepted) {
    reject(rule, result.reason ?? "artifact signature rejected", result.evidence ?? {});
  }
}

async function validateRebacPermission(
  rule: Extract<NormalizedAdmissionRule, { readonly type: "rebac_permission" }>,
  attrs: AdmissionAttributes,
): Promise<void> {
  const resolver = attrs.deps.permissionResolver;
  if (resolver === undefined) {
    reject(rule, "permission resolver is not configured");
  }

  const objectId = rebacObjectId(rule, attrs);
  const decision = await runDelegate(rule, "permission resolver failed", async () =>
    resolver.check({
      subjectType: "agent",
      subjectId: attrs.object.agent.agentId,
      permission: rule.permission,
      objectType: rule.objectType,
      objectId,
      zoneId: attrs.deps.zoneId,
    }),
  );

  if (!decision.allowed) {
    reject(rule, decision.reason ?? "permission denied", decision.evidence ?? {});
  }
}

function rebacObjectId(
  rule: Extract<NormalizedAdmissionRule, { readonly type: "rebac_permission" }>,
  attrs: AdmissionAttributes,
): string {
  const key = rule.objectIdContextKey;
  if (key === undefined) {
    return attrs.object.summary;
  }

  const contextObjectId = attrs.object.context?.[key];
  if (typeof contextObjectId === "string" && contextObjectId.length > 0) {
    return contextObjectId;
  }

  reject(rule, `permission object id context key '${key}' is missing or not a string`, {
    object_id_context_key: key,
    available_context_keys: Object.keys(attrs.object.context ?? {}),
  });
}

async function validateGovernancePolicy(
  rule: Extract<NormalizedAdmissionRule, { readonly type: "governance_policy" }>,
  attrs: AdmissionAttributes,
): Promise<void> {
  const evaluator = attrs.deps.governanceEvaluator;
  if (evaluator === undefined) {
    reject(rule, "governance evaluator is not configured");
  }

  const decision = await runDelegate(rule, "governance evaluator failed", async () =>
    evaluator.evaluate({
      policy: rule.policy,
      agentId: attrs.object.agent.agentId,
      zoneId: attrs.deps.zoneId,
      contribution: attrs.object,
      maxScore: rule.maxScore,
    }),
  );
  if (!decision.allowed) {
    reject(rule, decision.reason ?? "governance policy denied", decision.evidence ?? {});
  }
}

function reject(
  rule: NormalizedAdmissionRule,
  reason: string,
  evidence?: Readonly<Record<string, JsonValue>> | undefined,
): never {
  throw new AdmissionRejectError({
    ruleName: rule.name,
    ruleType: rule.type,
    reason,
    ...(evidence === undefined ? {} : { evidence }),
  });
}

function truncateEvidenceText(value: string): {
  readonly value: string;
  readonly truncated: boolean;
} {
  if (value.length <= MaxEvidenceTextLength) {
    return { value, truncated: false };
  }

  return { value: value.slice(0, MaxEvidenceTextLength), truncated: true };
}

async function runDelegate<T>(
  rule: NormalizedAdmissionRule,
  reason: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    reject(rule, reason, errorEvidence(error));
  }
}

function errorEvidence(error: unknown): Readonly<Record<string, JsonValue>> {
  const name = truncateEvidenceText(errorName(error));
  const message = truncateEvidenceText(errorMessage(error));

  return {
    error_name: name.value,
    error_message: message.value,
    ...(name.truncated ? { error_name_truncated: true } : {}),
    ...(message.truncated ? { error_message_truncated: true } : {}),
  };
}

function errorName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return "Error";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isMetricImprovesViolation(violation: PolicyViolation, metric: string): boolean {
  if (detailString(violation.details, "metric") !== metric) {
    return false;
  }

  if (violation.type === "gate_failed") {
    return detailString(violation.details, "gate") === "metric_improves";
  }

  if (violation.type !== "missing_score") {
    return false;
  }

  const requiredByGate = violation.details.requiredByGate;
  return requiredByGate === undefined || requiredByGate === true;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function detailString(details: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" ? value : undefined;
}

function jsonRecordFromUnknown(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, JsonValue>> {
  const record: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    record[key] = jsonValueFromUnknown(child);
  }
  return record;
}

function jsonValueFromUnknown(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
  }

  if (Array.isArray(value)) {
    return value.map((child) => jsonValueFromUnknown(child));
  }

  if (typeof value === "object") {
    const record: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      record[key] = jsonValueFromUnknown(child);
    }
    return record;
  }

  return String(value);
}
