import { describe, expect, test } from "bun:test";
import { getPreset, presetToSessionConfig } from "../../src/cli/presets/index.js";

describe("presetToSessionConfig", () => {
  test("review-loop produces a GroveContract with preset fields preserved", () => {
    const preset = getPreset("review-loop");
    expect(preset).toBeDefined();

    const contract = presetToSessionConfig(preset!, "my-grove");

    expect(contract.name).toBe("my-grove");
    expect(contract.mode).toBe("exploration");
    expect(contract.topology?.structure).toBe("graph");
    expect(contract.topology?.roles).toHaveLength(2);
    expect(contract.topology?.roles.map((r) => r.name)).toEqual(["coder", "reviewer"]);
    expect(contract.concurrency?.maxActiveClaims).toBe(4);
    expect(contract.execution?.defaultLeaseSeconds).toBe(300);
  });

  test("swarm-ops preset produces a GroveContract with tree topology", () => {
    const preset = getPreset("swarm-ops");
    const contract = presetToSessionConfig(preset!, "my-grove");
    expect(contract.topology?.structure).toBe("tree");
    expect(contract.topology?.roles.map((r) => r.name)).toEqual(["coordinator", "worker", "qa"]);
  });

  test("contract round-trips through parseGroveContract with no loss of topology fields", async () => {
    const preset = getPreset("review-loop");
    const contract = presetToSessionConfig(preset!, "my-grove");
    expect(contract.contractVersion).toBeGreaterThanOrEqual(2);
    expect(contract.topology?.spawning?.dynamic).toBe(true);
  });
});
