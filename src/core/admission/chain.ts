import { AdmissionRejectError } from "./errors.js";
import type {
  AdmissionAttributes,
  AdmissionAudit,
  AdmissionMutator,
  AdmissionResult,
  AdmissionRuleAudit,
  AdmissionValidator,
} from "./types.js";

export interface AdmissionChainOptions {
  readonly mutators: readonly AdmissionMutator[];
  readonly validators: readonly AdmissionValidator[];
}

function annotationsToRecord(annotations: Map<string, string>): Readonly<Record<string, string>> {
  return Object.fromEntries([...annotations.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function buildAudit(
  accepted: boolean,
  rules: readonly AdmissionRuleAudit[],
  annotations: Map<string, string>,
): AdmissionAudit {
  return {
    version: 1,
    accepted,
    evaluatedAt: new Date().toISOString(),
    rules,
    annotations: annotationsToRecord(annotations),
  };
}

export class AdmissionChain {
  private readonly mutators: readonly AdmissionMutator[];
  private readonly validators: readonly AdmissionValidator[];

  constructor(options: AdmissionChainOptions) {
    this.mutators = options.mutators;
    this.validators = options.validators;
  }

  async admit(attrs: AdmissionAttributes): Promise<AdmissionResult> {
    const rules: AdmissionRuleAudit[] = [];

    for (const mutator of this.mutators) {
      if (!mutator.handles(attrs.op)) {
        continue;
      }
      await mutator.mutate(attrs);
      rules.push({
        name: mutator.name,
        type: mutator.ruleType ?? "shell",
        accepted: true,
        evidence: { phase: "mutating" },
      });
    }

    for (const validator of this.validators) {
      if (!validator.handles(attrs.op)) {
        continue;
      }
      try {
        await validator.validate(attrs);
        rules.push({
          name: validator.name,
          type: validator.ruleType ?? "metric_check",
          accepted: true,
          evidence: { phase: "validating" },
        });
      } catch (err) {
        if (err instanceof AdmissionRejectError) {
          if (err.audit !== undefined) {
            throw err;
          }

          const rejectedRules: readonly AdmissionRuleAudit[] = [
            ...rules,
            {
              name: err.ruleName,
              type: err.ruleType,
              accepted: false,
              reason: err.reason,
              ...(err.evidence !== undefined ? { evidence: err.evidence } : {}),
            },
          ];
          throw new AdmissionRejectError({
            ruleName: err.ruleName,
            ruleType: err.ruleType,
            reason: err.reason,
            ...(err.evidence !== undefined ? { evidence: err.evidence } : {}),
            audit: buildAudit(false, rejectedRules, attrs.annotations),
          });
        }
        throw err;
      }
    }

    return {
      accepted: true,
      audit: buildAudit(true, rules, attrs.annotations),
    };
  }
}
