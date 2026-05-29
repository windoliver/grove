import { describe, expect, test } from "bun:test";

import type { GroveContract } from "../contract.js";
import {
  type Contribution,
  type ContributionInput,
  ContributionKind,
  ContributionMode,
  RelationType,
  ScoreDirection,
} from "../models.js";
import { makeInMemoryContributionStore } from "../operations/test-helpers.js";
import type { AdmissionDeps } from "./types.js";
import { createAdmissionValidators } from "./validators.js";

function input(overrides: Partial<ContributionInput> = {}): ContributionInput {
  return {
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "work",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "agent-1", role: "coder" },
    createdAt: "2026-05-27T00:00:00.000Z",
    ...overrides,
  };
}

function contribution(overrides: Partial<Contribution> = {}): Contribution {
  return {
    cid: "blake3:existing",
    manifestVersion: 1,
    ...input(),
    ...overrides,
  };
}

async function runValidator(
  rule: Parameters<typeof createAdmissionValidators>[0][number],
  object: ContributionInput,
  options: {
    readonly deps?: AdmissionDeps | undefined;
    readonly contract?: GroveContract | undefined;
  } = {},
): Promise<Map<string, string>> {
  const [validator] = createAdmissionValidators([rule]);
  if (validator === undefined) throw new Error("validator missing");
  const annotations = new Map<string, string>();
  await validator.validate({
    op: "contribute",
    object,
    annotations,
    ...(options.contract === undefined ? {} : { contract: options.contract }),
    deps: options.deps ?? {},
  });
  return annotations;
}

describe("createAdmissionValidators", () => {
  test("artifact_required accepts present artifact", async () => {
    const annotations = await runValidator(
      {
        type: "artifact_required",
        name: "requires_patch",
        artifact: "patch",
        source: "explicit",
      },
      input({ artifacts: { patch: "blake3:patch" } }),
    );

    expect(annotations.size).toBe(0);
  });

  test("artifact_required rejects missing artifact", async () => {
    await expect(
      runValidator(
        {
          type: "artifact_required",
          name: "requires_patch",
          artifact: "patch",
          source: "explicit",
        },
        input({ artifacts: { log: "blake3:log" } }),
      ),
    ).rejects.toMatchObject({
      ruleName: "requires_patch",
      ruleType: "artifact_required",
      reason: "missing artifact 'patch'",
      evidence: { artifact: "patch", present_artifacts: ["log"] },
    });
  });

  test("relation_required accepts present relation", async () => {
    await runValidator(
      {
        type: "relation_required",
        name: "requires_review",
        relationType: RelationType.Reviews,
        source: "explicit",
      },
      input({
        relations: [{ relationType: RelationType.Reviews, targetCid: "blake3:reviewed" }],
      }),
    );
  });

  test("relation_required rejects missing relation", async () => {
    await expect(
      runValidator(
        {
          type: "relation_required",
          name: "requires_review",
          relationType: RelationType.Reviews,
          source: "explicit",
        },
        input({
          relations: [{ relationType: RelationType.DerivesFrom, targetCid: "blake3:parent" }],
        }),
      ),
    ).rejects.toMatchObject({
      ruleName: "requires_review",
      ruleType: "relation_required",
      reason: "missing relation 'reviews'",
      evidence: {
        relation_type: "reviews",
        present_relation_types: ["derives_from"],
      },
    });
  });

  test("metric_check enforces minimum score and records accepted value", async () => {
    const annotations = await runValidator(
      {
        type: "metric_check",
        name: "coverage_floor",
        metric: "coverage",
        minValue: 0.8,
        source: "explicit",
      },
      input({
        scores: {
          coverage: { value: 0.92, direction: ScoreDirection.Maximize },
        },
      }),
    );

    expect(annotations.get("admission.metric.coverage_floor.value")).toBe("0.92");

    await expect(
      runValidator(
        {
          type: "metric_check",
          name: "coverage_floor",
          metric: "coverage",
          minValue: 0.8,
          source: "explicit",
        },
        input({
          scores: {
            coverage: { value: 0.7, direction: ScoreDirection.Maximize },
          },
        }),
      ),
    ).rejects.toMatchObject({
      ruleName: "coverage_floor",
      ruleType: "metric_check",
      reason: "metric 'coverage' is below minimum",
      evidence: { metric: "coverage", value: 0.7, min_value: 0.8 },
    });
  });

  test("metric_check rejects missing metric", async () => {
    await expect(
      runValidator(
        {
          type: "metric_check",
          name: "coverage_floor",
          metric: "coverage",
          minValue: 0.8,
          source: "explicit",
        },
        input(),
      ),
    ).rejects.toMatchObject({
      reason: "missing metric 'coverage'",
      evidence: { metric: "coverage" },
    });
  });

  test("shell validator uses HookRunner and records exit-code annotation", async () => {
    const seen: string[] = [];
    const annotations = await runValidator(
      {
        type: "shell",
        name: "lint",
        command: "bun run check",
        timeout: 5000,
        onFail: "reject",
        source: "explicit",
      },
      input(),
      {
        deps: {
          hookCwd: "/tmp/grove",
          hookRunner: {
            run: async (entry, cwd) => {
              seen.push(`${typeof entry === "string" ? entry : entry.cmd}:${cwd}`);
              return {
                success: true,
                exitCode: 0,
                stdout: "",
                stderr: "",
                command: "bun run check",
                durationMs: 12,
              };
            },
          },
        },
      },
    );

    expect(seen).toEqual(["bun run check:/tmp/grove"]);
    expect(annotations.get("admission.shell.lint.exit_code")).toBe("0");
    expect(annotations.get("admission.shell.lint.duration_ms")).toBe("12");
  });

  test("shell validator rejects failed command unless onFail is warn", async () => {
    const deps: AdmissionDeps = {
      hookCwd: "/tmp/grove",
      hookRunner: {
        run: async () => ({
          success: false,
          exitCode: 2,
          stdout: "stdout",
          stderr: "stderr",
          command: "bun run check",
          durationMs: 10,
        }),
      },
    };

    await expect(
      runValidator(
        {
          type: "shell",
          name: "lint",
          command: "bun run check",
          onFail: "reject",
          source: "explicit",
        },
        input(),
        { deps },
      ),
    ).rejects.toMatchObject({
      ruleName: "lint",
      ruleType: "shell",
      reason: "shell command failed",
      evidence: {
        command: "bun run check",
        exit_code: 2,
        stdout: "stdout",
        stderr: "stderr",
        stdout_truncated: false,
        stderr_truncated: false,
      },
    });

    await runValidator(
      {
        type: "shell",
        name: "lint_warn",
        command: "bun run check",
        onFail: "warn",
        source: "explicit",
      },
      input(),
      { deps },
    );
  });

  test("shell validator rejects failed command when onFail is omitted", async () => {
    await expect(
      runValidator(
        {
          type: "shell",
          name: "lint",
          command: "bun run check",
          source: "explicit",
        },
        input(),
        {
          deps: {
            hookCwd: "/tmp/grove",
            hookRunner: {
              run: async () => ({
                success: false,
                exitCode: 2,
                stdout: "",
                stderr: "",
                command: "bun run check",
                durationMs: 10,
              }),
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      ruleName: "lint",
      ruleType: "shell",
      reason: "shell command failed",
    });
  });

  test("shell validator truncates stdout and stderr evidence", async () => {
    const longStdout = "o".repeat(5000);
    const longStderr = "e".repeat(5000);

    await expect(
      runValidator(
        {
          type: "shell",
          name: "lint",
          command: "bun run check",
          onFail: "reject",
          source: "explicit",
        },
        input(),
        {
          deps: {
            hookCwd: "/tmp/grove",
            hookRunner: {
              run: async () => ({
                success: false,
                exitCode: 2,
                stdout: longStdout,
                stderr: longStderr,
                command: "bun run check",
                durationMs: 10,
              }),
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      evidence: {
        stdout: "o".repeat(4096),
        stderr: "e".repeat(4096),
        stdout_truncated: true,
        stderr_truncated: true,
      },
    });
  });

  test("metric_improves rejects when score does not improve store baseline", async () => {
    const contract: GroveContract = {
      contractVersion: 2,
      name: "test",
      metrics: { loss: { direction: ScoreDirection.Minimize } },
      gates: [{ type: "metric_improves", metric: "loss" }],
    };

    await expect(
      runValidator(
        {
          type: "metric_improves",
          name: "loss_improves",
          metric: "loss",
          source: "legacy_gate",
        },
        input({
          scores: { loss: { value: 0.5, direction: ScoreDirection.Minimize } },
        }),
        {
          contract,
          deps: {
            contributionStore: makeInMemoryContributionStore([
              contribution({
                scores: { loss: { value: 0.4, direction: ScoreDirection.Minimize } },
              }),
            ]),
          },
        },
      ),
    ).rejects.toMatchObject({
      ruleName: "loss_improves",
      ruleType: "metric_improves",
      reason: expect.stringContaining("metric_improves"),
      evidence: {
        gate: "metric_improves",
        metric: "loss",
        currentValue: 0.5,
        bestValue: 0.4,
      },
    });
  });

  test("metric_improves rejects when candidate lacks the metric", async () => {
    const contract: GroveContract = {
      contractVersion: 2,
      name: "test",
      metrics: { loss: { direction: ScoreDirection.Minimize } },
      gates: [{ type: "metric_improves", metric: "loss" }],
    };

    await expect(
      runValidator(
        {
          type: "metric_improves",
          name: "loss_improves",
          metric: "loss",
          source: "legacy_gate",
        },
        input(),
        {
          contract,
          deps: {
            contributionStore: makeInMemoryContributionStore([
              contribution({
                scores: { loss: { value: 0.4, direction: ScoreDirection.Minimize } },
              }),
            ]),
          },
        },
      ),
    ).rejects.toMatchObject({
      ruleName: "loss_improves",
      ruleType: "metric_improves",
      reason: "Metric 'loss' is required by gate but not provided in scores",
      evidence: {
        metric: "loss",
        requiredByGate: true,
        providedScores: [],
      },
    });
  });

  test("blueprint_hash compares observed and expected hashes", async () => {
    await expect(
      runValidator(
        {
          type: "blueprint_hash",
          name: "blueprint",
          blueprint: "blueprints/main.md",
          expectedHash: "sha256:expected",
          source: "explicit",
        },
        input(),
        {
          deps: {
            blueprintHashSource: {
              hash: async () => "sha256:observed",
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      reason: "blueprint hash mismatch",
      evidence: {
        blueprint: "blueprints/main.md",
        observed_hash: "sha256:observed",
        expected_hash: "sha256:expected",
      },
    });

    await runValidator(
      {
        type: "blueprint_hash",
        name: "blueprint",
        blueprint: "blueprints/main.md",
        source: "explicit",
      },
      input({ context: { blueprint_hash: "sha256:observed" } }),
      {
        deps: {
          blueprintHashSource: {
            hash: async () => "sha256:observed",
          },
        },
      },
    );
  });

  test("blueprint_hash includes blueprint evidence when expected hash is missing", async () => {
    await expect(
      runValidator(
        {
          type: "blueprint_hash",
          name: "blueprint",
          blueprint: "blueprints/main.md",
          source: "explicit",
        },
        input({ context: { blueprint_hash: 42 } }),
        {
          deps: {
            blueprintHashSource: {
              hash: async () => "sha256:observed",
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      reason: "expected blueprint hash is missing",
      evidence: { blueprint: "blueprints/main.md" },
    });
  });

  test("blueprint_hash converts source throws into admission rejections", async () => {
    await expect(
      runValidator(
        {
          type: "blueprint_hash",
          name: "blueprint",
          blueprint: "blueprints/main.md",
          expectedHash: "sha256:expected",
          source: "explicit",
        },
        input(),
        {
          deps: {
            blueprintHashSource: {
              hash: async () => {
                throw new TypeError("hash backend unavailable");
              },
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      ruleName: "blueprint",
      ruleType: "blueprint_hash",
      reason: "blueprint hash source failed",
      evidence: {
        error_name: "TypeError",
        error_message: "hash backend unavailable",
      },
    });
  });

  test("artifact_signature uses verifier and rejects denies", async () => {
    const calls: string[] = [];

    await expect(
      runValidator(
        {
          type: "artifact_signature",
          name: "signature",
          artifact: "patch",
          requireSignerIn: ["maintainer"],
          source: "explicit",
        },
        input({ artifacts: { patch: "blake3:patch", log: "blake3:log" } }),
        {
          deps: {
            artifactSignatureVerifier: {
              verify: async (request) => {
                calls.push(`${request.artifactName}:${request.artifactHashes.patch}`);
                return {
                  accepted: false,
                  reason: "signer missing",
                  evidence: { signer: "agent-1" },
                };
              },
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      ruleName: "signature",
      ruleType: "artifact_signature",
      reason: "signer missing",
      evidence: { signer: "agent-1" },
    });

    expect(calls).toEqual(["patch:blake3:patch"]);
  });

  test("artifact_signature converts verifier throws into admission rejections", async () => {
    await expect(
      runValidator(
        {
          type: "artifact_signature",
          name: "signature",
          artifact: "patch",
          requireSignerIn: ["maintainer"],
          source: "explicit",
        },
        input({ artifacts: { patch: "blake3:patch" } }),
        {
          deps: {
            artifactSignatureVerifier: {
              verify: async () => {
                throw new Error("signature service offline");
              },
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      ruleName: "signature",
      ruleType: "artifact_signature",
      reason: "artifact signature verifier failed",
      evidence: {
        error_name: "Error",
        error_message: "signature service offline",
      },
    });
  });

  test("artifact_signature rejects missing named artifact before verifier call", async () => {
    let calls = 0;

    await expect(
      runValidator(
        {
          type: "artifact_signature",
          name: "signature",
          artifact: "patch",
          requireSignerIn: ["maintainer"],
          source: "explicit",
        },
        input({ artifacts: { log: "blake3:log" } }),
        {
          deps: {
            artifactSignatureVerifier: {
              verify: async () => {
                calls += 1;
                return { accepted: true };
              },
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      ruleName: "signature",
      ruleType: "artifact_signature",
      reason: "missing artifact 'patch' for signature verification",
      evidence: { artifact: "patch", present_artifacts: ["log"] },
    });

    expect(calls).toBe(0);
  });

  test("rebac_permission uses permission resolver and rejects denies", async () => {
    const calls: string[] = [];

    await expect(
      runValidator(
        {
          type: "rebac_permission",
          name: "can_submit",
          permission: "contribute",
          objectType: "workspace",
          objectIdContextKey: "workspace_id",
          source: "explicit",
        },
        input({ context: { workspace_id: "workspace-1" } }),
        {
          deps: {
            zoneId: "zone-1",
            permissionResolver: {
              check: async (request) => {
                calls.push(
                  `${request.subjectType}:${request.subjectId}:${request.permission}:${request.objectId}:${request.zoneId}`,
                );
                return {
                  allowed: false,
                  reason: "permission denied by test",
                  evidence: { policy: "deny" },
                };
              },
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      ruleName: "can_submit",
      ruleType: "rebac_permission",
      reason: "permission denied by test",
      evidence: { policy: "deny" },
    });

    expect(calls).toEqual(["agent:agent-1:contribute:workspace-1:zone-1"]);
  });

  test("rebac_permission rejects missing configured context object id", async () => {
    let calls = 0;

    await expect(
      runValidator(
        {
          type: "rebac_permission",
          name: "can_submit",
          permission: "contribute",
          objectType: "workspace",
          objectIdContextKey: "workspace_id",
          source: "explicit",
        },
        input({ context: { team_id: "team-1" }, summary: "fallback-object" }),
        {
          deps: {
            permissionResolver: {
              check: async () => {
                calls += 1;
                return { allowed: true };
              },
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      ruleName: "can_submit",
      ruleType: "rebac_permission",
      reason: "permission object id context key 'workspace_id' is missing or not a string",
      evidence: {
        object_id_context_key: "workspace_id",
        available_context_keys: ["team_id"],
      },
    });

    expect(calls).toBe(0);
  });

  test("rebac_permission rejects non-string or empty configured context object id", async () => {
    const invalidValues = [123, ""];

    for (const value of invalidValues) {
      let calls = 0;

      await expect(
        runValidator(
          {
            type: "rebac_permission",
            name: "can_submit",
            permission: "contribute",
            objectType: "workspace",
            objectIdContextKey: "workspace_id",
            source: "explicit",
          },
          input({
            context: { workspace_id: value, team_id: "team-1" },
            summary: "fallback-object",
          }),
          {
            deps: {
              permissionResolver: {
                check: async () => {
                  calls += 1;
                  return { allowed: true };
                },
              },
            },
          },
        ),
      ).rejects.toMatchObject({
        ruleName: "can_submit",
        ruleType: "rebac_permission",
        reason: "permission object id context key 'workspace_id' is missing or not a string",
        evidence: {
          object_id_context_key: "workspace_id",
          available_context_keys: ["workspace_id", "team_id"],
        },
      });

      expect(calls).toBe(0);
    }
  });

  test("rebac_permission falls back to summary when no context object id key is configured", async () => {
    const calls: string[] = [];

    await runValidator(
      {
        type: "rebac_permission",
        name: "can_submit",
        permission: "contribute",
        objectType: "workspace",
        source: "explicit",
      },
      input({ context: { workspace_id: 123 }, summary: "fallback-object" }),
      {
        deps: {
          permissionResolver: {
            check: async (request) => {
              calls.push(request.objectId);
              return { allowed: true };
            },
          },
        },
      },
    );

    expect(calls).toEqual(["fallback-object"]);
  });

  test("rebac_permission converts resolver throws into admission rejections", async () => {
    await expect(
      runValidator(
        {
          type: "rebac_permission",
          name: "can_submit",
          permission: "contribute",
          objectType: "workspace",
          source: "explicit",
        },
        input(),
        {
          deps: {
            permissionResolver: {
              check: async () => {
                throw new RangeError("resolver unavailable");
              },
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      ruleName: "can_submit",
      ruleType: "rebac_permission",
      reason: "permission resolver failed",
      evidence: {
        error_name: "RangeError",
        error_message: "resolver unavailable",
      },
    });
  });

  test("governance_policy uses governance evaluator and rejects denies", async () => {
    const calls: string[] = [];

    await expect(
      runValidator(
        {
          type: "governance_policy",
          name: "fraud_check",
          policy: "fraud_score_below",
          maxScore: 0.2,
          source: "explicit",
        },
        input(),
        {
          deps: {
            zoneId: "zone-1",
            governanceEvaluator: {
              evaluate: async (request) => {
                calls.push(
                  `${request.policy}:${request.agentId}:${request.zoneId}:${request.maxScore}`,
                );
                return {
                  allowed: false,
                  reason: "fraud score too high",
                  evidence: { score: 0.4 },
                };
              },
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      ruleName: "fraud_check",
      ruleType: "governance_policy",
      reason: "fraud score too high",
      evidence: { score: 0.4 },
    });

    expect(calls).toEqual(["fraud_score_below:agent-1:zone-1:0.2"]);
  });

  test("governance_policy converts evaluator throws into admission rejections", async () => {
    await expect(
      runValidator(
        {
          type: "governance_policy",
          name: "fraud_check",
          policy: "fraud_score_below",
          source: "explicit",
        },
        input(),
        {
          deps: {
            governanceEvaluator: {
              evaluate: async () => {
                throw new Error("governance backend timed out");
              },
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      ruleName: "fraud_check",
      ruleType: "governance_policy",
      reason: "governance evaluator failed",
      evidence: {
        error_name: "Error",
        error_message: "governance backend timed out",
      },
    });
  });
});
