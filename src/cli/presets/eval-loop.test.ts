/**
 * Tests for the eval-loop preset (Hive-style competitive benchmark).
 */

import { describe, expect, test } from "bun:test";

import { getPreset, presetToSessionConfig } from "./index.js";

describe("eval-loop preset", () => {
  test("is registered with a flat, 8-instance competitor topology", () => {
    const preset = getPreset("eval-loop")!;
    expect(preset).toBeDefined();
    expect(preset.mode).toBe("evaluation");
    expect(preset.topology?.structure).toBe("flat");
    expect(preset.topology?.roles).toHaveLength(1);
    expect(preset.topology?.roles[0]?.name).toBe("competitor");
    expect(preset.topology?.roles[0]?.maxInstances).toBe(8);
  });

  test("declares a score:maximize metric with a metric_improves gate", () => {
    const preset = getPreset("eval-loop")!;
    expect(preset.metrics).toContainEqual(
      expect.objectContaining({ name: "score", direction: "maximize" }),
    );
    expect(preset.gates).toContainEqual({ type: "metric_improves", metric: "score" });
  });

  test("declares an eval hook placeholder", () => {
    const preset = getPreset("eval-loop")!;
    expect(preset.hooks?.eval).toBeTruthy();
  });

  test("round-trips through GROVE.md with hooks.eval and the score metric", () => {
    const preset = getPreset("eval-loop")!;
    const contract = presetToSessionConfig(preset, "My Benchmark");

    expect(contract.name).toBe("My Benchmark");
    expect(contract.mode).toBe("evaluation");
    expect(contract.hooks?.eval).toBeTruthy();
    expect(contract.metrics?.score?.direction).toBe("maximize");
    expect(contract.gates?.some((g) => g.type === "metric_improves" && g.metric === "score")).toBe(
      true,
    );
  });
});
