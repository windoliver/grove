import { describe, expect, test } from "bun:test";

import { type ContributionInput, ContributionKind, ContributionMode } from "../models.js";
import { fromGroveError, OperationErrorCode } from "../operations/result.js";
import { AdmissionChain } from "./chain.js";
import { AdmissionRejectError } from "./errors.js";
import {
  type AdmissionAudit,
  type AdmissionMutator,
  AdmissionOp,
  type AdmissionValidator,
} from "./types.js";

function input(): ContributionInput {
  return {
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "work",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "agent-1" },
    createdAt: "2026-05-27T00:00:00.000Z",
  };
}

describe("AdmissionChain", () => {
  test("runs mutators before validators and validators see final object", async () => {
    const calls: string[] = [];
    const mutator: AdmissionMutator = {
      name: "add-tag",
      ruleType: "blueprint_hash",
      handles: () => true,
      mutate: async (attrs) => {
        calls.push("mutator");
        attrs.object = { ...attrs.object, tags: [...attrs.object.tags, "mutated"] };
        attrs.annotations.set("mutated", "true");
        attrs.annotations.set("alpha", "first");
      },
    };
    const validator: AdmissionValidator = {
      name: "see-tag",
      ruleType: "artifact_required",
      handles: () => true,
      validate: async (attrs) => {
        calls.push(`validator:${attrs.object.tags.join(",")}`);
        attrs.annotations.set("middle", "second");
      },
    };

    const chain = new AdmissionChain({ mutators: [mutator], validators: [validator] });
    const result = await chain.admit({
      op: AdmissionOp.Contribute,
      object: input(),
      annotations: new Map(),
      deps: {},
    });

    expect(calls).toEqual(["mutator", "validator:mutated"]);
    expect(result.accepted).toBe(true);
    expect(result.audit.accepted).toBe(true);
    expect(result.audit.rules).toEqual([
      {
        name: "add-tag",
        type: "blueprint_hash",
        accepted: true,
        evidence: { phase: "mutating" },
      },
      {
        name: "see-tag",
        type: "artifact_required",
        accepted: true,
        evidence: { phase: "validating" },
      },
    ]);
    expect(Object.keys(result.audit.annotations)).toEqual(["alpha", "middle", "mutated"]);
    expect(result.audit.annotations).toEqual({
      alpha: "first",
      middle: "second",
      mutated: "true",
    });
  });

  test("skips handlers that do not handle the operation", async () => {
    const calls: string[] = [];
    const chain = new AdmissionChain({
      mutators: [
        {
          name: "skipped-mutator",
          handles: () => false,
          mutate: async () => {
            calls.push("skipped-mutator");
          },
        },
        {
          name: "handled-mutator",
          handles: () => true,
          mutate: async () => {
            calls.push("handled-mutator");
          },
        },
      ],
      validators: [
        {
          name: "skipped-validator",
          handles: () => false,
          validate: async () => {
            calls.push("skipped-validator");
          },
        },
        {
          name: "handled-validator",
          handles: () => true,
          validate: async () => {
            calls.push("handled-validator");
          },
        },
      ],
    });

    const result = await chain.admit({
      op: AdmissionOp.Contribute,
      object: input(),
      annotations: new Map(),
      deps: {},
    });

    expect(calls).toEqual(["handled-mutator", "handled-validator"]);
    expect(result.audit.rules.map((rule) => rule.name)).toEqual([
      "handled-mutator",
      "handled-validator",
    ]);
  });

  test("fails fast on validator rejection", async () => {
    const calls: string[] = [];
    const chain = new AdmissionChain({
      mutators: [],
      validators: [
        {
          name: "reject",
          handles: () => true,
          validate: async () => {
            calls.push("reject");
            throw new AdmissionRejectError({
              ruleName: "reject",
              ruleType: "metric_check",
              reason: "score too low",
              evidence: { score: 0.2 },
            });
          },
        },
        {
          name: "never",
          handles: () => true,
          validate: async () => {
            calls.push("never");
          },
        },
      ],
    });

    await expect(
      chain.admit({
        op: AdmissionOp.Contribute,
        object: input(),
        annotations: new Map(),
        deps: {},
      }),
    ).rejects.toBeInstanceOf(AdmissionRejectError);
    expect(calls).toEqual(["reject"]);
  });

  test("rejection error carries audit with prior accepted rules and sorted annotations", async () => {
    const chain = new AdmissionChain({
      mutators: [
        {
          name: "prepare",
          handles: () => true,
          mutate: async (attrs) => {
            attrs.annotations.set("zeta", "last");
            attrs.annotations.set("alpha", "first");
          },
        },
      ],
      validators: [
        {
          name: "reject",
          ruleType: "governance_policy",
          handles: () => true,
          validate: async (attrs) => {
            attrs.annotations.set("middle", "second");
            throw new AdmissionRejectError({
              ruleName: "reject",
              ruleType: "governance_policy",
              reason: "policy denied",
              evidence: { policy: "constraint_check" },
            });
          },
        },
      ],
    });

    try {
      await chain.admit({
        op: AdmissionOp.Contribute,
        object: input(),
        annotations: new Map(),
        deps: {},
      });
      throw new Error("expected admission rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(AdmissionRejectError);
      const error = err as AdmissionRejectError;
      expect(error.audit?.accepted).toBe(false);
      expect(error.audit?.rules).toEqual([
        {
          name: "prepare",
          type: "shell",
          accepted: true,
          evidence: { phase: "mutating" },
        },
        {
          name: "reject",
          type: "governance_policy",
          accepted: false,
          reason: "policy denied",
          evidence: { policy: "constraint_check" },
        },
      ]);
      expect(Object.keys(error.audit?.annotations ?? {})).toEqual(["alpha", "middle", "zeta"]);
      expect(error.audit?.annotations).toEqual({
        alpha: "first",
        middle: "second",
        zeta: "last",
      });
    }
  });

  test("rethrows admission rejection when it already carries audit", async () => {
    const existingAudit: AdmissionAudit = {
      version: 1,
      accepted: false,
      evaluatedAt: "2026-05-27T00:00:00.000Z",
      rules: [
        {
          name: "external-reject",
          type: "artifact_required",
          accepted: false,
          reason: "missing artifact",
        },
      ],
      annotations: { source: "upstream" },
    };
    const rejection = new AdmissionRejectError({
      ruleName: "external-reject",
      ruleType: "artifact_required",
      reason: "missing artifact",
      audit: existingAudit,
    });
    const chain = new AdmissionChain({
      mutators: [],
      validators: [
        {
          name: "external-reject",
          handles: () => true,
          validate: async () => {
            throw rejection;
          },
        },
      ],
    });

    await expect(
      chain.admit({
        op: AdmissionOp.Contribute,
        object: input(),
        annotations: new Map(),
        deps: {},
      }),
    ).rejects.toBe(rejection);
  });

  test("AdmissionRejectError snapshots mutable evidence and rejection audit evidence", async () => {
    const evidence = {
      score: 0.2,
      nested: { label: "initial", flags: ["original"] },
    };
    const standalone = new AdmissionRejectError({
      ruleName: "score-gate",
      ruleType: "metric_check",
      reason: "score too low",
      evidence,
    });
    evidence.score = 0.9;
    evidence.nested.label = "mutated";
    evidence.nested.flags.push("mutated");

    expect(standalone.evidence).toEqual({
      score: 0.2,
      nested: { label: "initial", flags: ["original"] },
    });

    const rejectionEvidence = {
      policy: "constraint_check",
      nested: { label: "original" },
    };
    const chain = new AdmissionChain({
      mutators: [],
      validators: [
        {
          name: "policy",
          handles: () => true,
          validate: async () => {
            const rejection = new AdmissionRejectError({
              ruleName: "policy",
              ruleType: "governance_policy",
              reason: "policy denied",
              evidence: rejectionEvidence,
            });
            rejectionEvidence.policy = "mutated";
            rejectionEvidence.nested.label = "mutated";
            throw rejection;
          },
        },
      ],
    });

    try {
      await chain.admit({
        op: AdmissionOp.Contribute,
        object: input(),
        annotations: new Map(),
        deps: {},
      });
      throw new Error("expected admission rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(AdmissionRejectError);
      const error = err as AdmissionRejectError;
      expect(error.evidence).toEqual({
        policy: "constraint_check",
        nested: { label: "original" },
      });
      expect(error.audit?.rules).toEqual([
        {
          name: "policy",
          type: "governance_policy",
          accepted: false,
          reason: "policy denied",
          evidence: {
            policy: "constraint_check",
            nested: { label: "original" },
          },
        },
      ]);
    }
  });

  test("fromGroveError maps admission rejection details and audit", () => {
    const audit: AdmissionAudit = {
      version: 1,
      accepted: false,
      evaluatedAt: "2026-05-27T00:00:00.000Z",
      rules: [
        {
          name: "signature",
          type: "artifact_signature",
          accepted: false,
          reason: "unsigned artifact",
          evidence: { artifact: "report.md" },
        },
      ],
      annotations: { artifact: "report.md" },
    };
    const result = fromGroveError(
      new AdmissionRejectError({
        ruleName: "signature",
        ruleType: "artifact_signature",
        reason: "unsigned artifact",
        evidence: { artifact: "report.md" },
        audit,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(OperationErrorCode.PolicyViolation);
    expect(result.error.details).toEqual({
      violationType: "admission_rejected",
      ruleName: "signature",
      ruleType: "artifact_signature",
      reason: "unsigned artifact",
      evidence: { artifact: "report.md" },
      admissionAudit: audit,
    });
  });
});
