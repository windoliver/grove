import type { AdmissionRule, GroveContract } from "../contract.js";
import type { HookEntry, HookRunner } from "../hooks.js";
import type { ContributionInput, JsonValue, ScoreDirection } from "../models.js";
import type { ContributionStore } from "../store.js";

export const AdmissionOp = {
  Contribute: "contribute",
} as const;
export type AdmissionOp = (typeof AdmissionOp)[keyof typeof AdmissionOp];

export type AdmissionRuleSource = "explicit" | "legacy_hook" | "legacy_gate";

export type NormalizedAdmissionRule =
  | (AdmissionRule & { readonly source: AdmissionRuleSource })
  | {
      readonly type: "metric_improves";
      readonly name: string;
      readonly metric: string;
      readonly source: AdmissionRuleSource;
    };

export interface AdmissionRuleAudit {
  readonly name: string;
  readonly type: NormalizedAdmissionRule["type"];
  readonly accepted: boolean;
  readonly reason?: string | undefined;
  readonly evidence?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface AdmissionAudit {
  readonly version: 1;
  readonly accepted: boolean;
  readonly evaluatedAt: string;
  readonly rules: readonly AdmissionRuleAudit[];
  readonly annotations: Readonly<Record<string, string>>;
}

export interface AdmissionResult {
  readonly accepted: boolean;
  readonly audit: AdmissionAudit;
}

export interface AdmissionAttributes {
  readonly op: AdmissionOp;
  object: ContributionInput;
  readonly originalObject?: ContributionInput | undefined;
  readonly contract?: GroveContract | undefined;
  readonly annotations: Map<string, string>;
  readonly deps: AdmissionDeps;
}

export interface AdmissionMutator {
  readonly name: string;
  handles(op: AdmissionOp): boolean;
  mutate(attrs: AdmissionAttributes): Promise<void>;
}

export interface AdmissionValidator {
  readonly name: string;
  handles(op: AdmissionOp): boolean;
  validate(attrs: AdmissionAttributes): Promise<void>;
}

export interface AdmissionPermissionCheck {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly permission: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly zoneId?: string | undefined;
}

export interface AdmissionPermissionDecision {
  readonly allowed: boolean;
  readonly reason?: string | undefined;
  readonly evidence?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface AdmissionPermissionResolver {
  check(input: AdmissionPermissionCheck): Promise<AdmissionPermissionDecision>;
}

export interface AdmissionGovernanceCheck {
  readonly policy: string;
  readonly agentId: string;
  readonly zoneId?: string | undefined;
  readonly contribution: ContributionInput;
  readonly maxScore?: number | undefined;
}

export interface AdmissionGovernanceDecision {
  readonly allowed: boolean;
  readonly reason?: string | undefined;
  readonly evidence?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface AdmissionGovernanceEvaluator {
  evaluate(input: AdmissionGovernanceCheck): Promise<AdmissionGovernanceDecision>;
}

export interface BlueprintHashSource {
  hash(path: string): Promise<string | undefined>;
}

export interface ArtifactSignatureVerificationInput {
  readonly artifactName?: string | undefined;
  readonly artifactHashes: Readonly<Record<string, string>>;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly requireSignerIn: readonly string[];
}

export interface ArtifactSignatureVerificationResult {
  readonly accepted: boolean;
  readonly reason?: string | undefined;
  readonly evidence?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface ArtifactSignatureVerifier {
  verify(input: ArtifactSignatureVerificationInput): Promise<ArtifactSignatureVerificationResult>;
}

export interface AdmissionDeps {
  readonly contributionStore?: ContributionStore | undefined;
  readonly hookRunner?: HookRunner | undefined;
  readonly hookCwd?: string | undefined;
  readonly permissionResolver?: AdmissionPermissionResolver | undefined;
  readonly governanceEvaluator?: AdmissionGovernanceEvaluator | undefined;
  readonly blueprintHashSource?: BlueprintHashSource | undefined;
  readonly artifactSignatureVerifier?: ArtifactSignatureVerifier | undefined;
  readonly zoneId?: string | undefined;
}

export function hookEntryFromShellRule(rule: {
  readonly command: string;
  readonly timeout?: number | undefined;
}): HookEntry {
  return rule.timeout === undefined ? rule.command : { cmd: rule.command, timeout: rule.timeout };
}

export function scoreDirectionForRule(rule: { readonly direction?: ScoreDirection }): string {
  return rule.direction ?? "unspecified";
}

export function jsonRecord(
  value: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  return value;
}
