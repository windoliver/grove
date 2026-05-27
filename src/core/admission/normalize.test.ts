import { describe, expect, test } from "bun:test";

import type { GroveContract } from "../contract.js";
import { normalizeAdmissionRules } from "./normalize.js";

function contract(overrides: Partial<GroveContract>): GroveContract {
  return { contractVersion: 3, name: "test", ...overrides };
}

describe("normalizeAdmissionRules", () => {
  test("returns no admission rules when contract is undefined", () => {
    expect(normalizeAdmissionRules(undefined)).toEqual([]);
  });

  test("keeps explicit admission rules first", () => {
    const rules = normalizeAdmissionRules(
      contract({
        admission: [{ type: "shell", name: "lint", command: "bun run lint" }],
        gates: [{ type: "has_artifact", name: "report.json" }],
      }),
    );

    expect(rules.map((r) => r.name)).toEqual(["lint", "gate_has_artifact_report_json"]);
  });

  test("converts before_contribute hook to shell validator", () => {
    const rules = normalizeAdmissionRules(
      contract({
        hooks: { before_contribute: { cmd: "bun test", timeout: 12_000 } },
      }),
    );

    expect(rules).toEqual([
      {
        type: "shell",
        name: "before_contribute",
        command: "bun test",
        timeout: 12_000,
        onFail: "reject",
        source: "legacy_hook",
      },
    ]);
  });

  test("explicit before_contribute admission rule shadows legacy hook", () => {
    const rules = normalizeAdmissionRules(
      contract({
        admission: [{ type: "shell", name: "before_contribute", command: "bun run check" }],
        hooks: { before_contribute: { cmd: "bun test" } },
      }),
    );

    expect(rules).toEqual([
      {
        type: "shell",
        name: "before_contribute",
        command: "bun run check",
        source: "explicit",
      },
    ]);
  });

  test("explicit admission rule with generated gate name shadows legacy gate", () => {
    const rules = normalizeAdmissionRules(
      contract({
        admission: [
          { type: "shell", name: "gate_has_artifact_report_json", command: "bun run check" },
        ],
        gates: [{ type: "has_artifact", name: "report.json" }],
      }),
    );

    expect(rules).toEqual([
      {
        type: "shell",
        name: "gate_has_artifact_report_json",
        command: "bun run check",
        source: "explicit",
      },
    ]);
  });

  test("keeps distinct legacy artifact gates that generate the same base name", () => {
    const rules = normalizeAdmissionRules(
      contract({
        gates: [
          { type: "has_artifact", name: "a.b" },
          { type: "has_artifact", name: "a/b" },
        ],
      }),
    );

    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({
      type: "artifact_required",
      name: "gate_has_artifact_a_b",
      artifact: "a.b",
      source: "legacy_gate",
    });
    expect(rules[1]).toMatchObject({
      type: "artifact_required",
      artifact: "a/b",
      source: "legacy_gate",
    });
    expect(rules[1]?.name).not.toBe("gate_has_artifact_a_b");
    expect(rules[1]?.name.startsWith("gate_has_artifact_a_b_")).toBe(true);
  });

  test("collapses duplicate identical legacy gates", () => {
    const rules = normalizeAdmissionRules(
      contract({
        gates: [
          { type: "has_artifact", name: "report.json" },
          { type: "has_artifact", name: "report.json" },
        ],
      }),
    );

    expect(rules).toEqual([
      {
        type: "artifact_required",
        name: "gate_has_artifact_report_json",
        artifact: "report.json",
        source: "legacy_gate",
      },
    ]);
  });

  test("converts legacy gates to admission validators", () => {
    const rules = normalizeAdmissionRules(
      contract({
        gates: [
          { type: "metric_improves", metric: "accuracy" },
          { type: "has_artifact", name: "report.json" },
          { type: "has_relation", relationType: "derives_from" },
          { type: "min_score", metric: "coverage", threshold: 0.8 },
          { type: "min_reviews", count: 2 },
        ],
      }),
    );

    expect(rules).toEqual([
      {
        type: "metric_improves",
        name: "gate_metric_improves_accuracy",
        metric: "accuracy",
        source: "legacy_gate",
      },
      {
        type: "artifact_required",
        name: "gate_has_artifact_report_json",
        artifact: "report.json",
        source: "legacy_gate",
      },
      {
        type: "relation_required",
        name: "gate_has_relation_derives_from",
        relationType: "derives_from",
        source: "legacy_gate",
      },
      {
        type: "metric_check",
        name: "gate_min_score_coverage",
        metric: "coverage",
        minValue: 0.8,
        source: "legacy_gate",
      },
    ]);
  });
});
