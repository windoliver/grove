import { describe, expect, test } from "bun:test";
import { buildGroveMd, presetToGroveMdConfig } from "../../src/cli/grove-md-builder.js";
import { getPreset, presetToSessionConfig } from "../../src/cli/presets/index.js";
import { parseGroveContract } from "../../src/core/contract.js";

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
    expect(preset).toBeDefined();
    const contract = presetToSessionConfig(preset!, "my-grove");
    expect(contract.topology?.structure).toBe("tree");
    expect(contract.topology?.roles.map((r) => r.name)).toEqual(["coordinator", "worker", "qa"]);
  });

  test("matches a direct parseGroveContract(buildGroveMd(presetToGroveMdConfig(...))) pipeline", () => {
    const preset = getPreset("review-loop");
    expect(preset).toBeDefined();

    const viaHelper = presetToSessionConfig(preset!, "my-grove");

    // Build the same contract by calling the pipeline the helper wraps.
    // These modules are already exercised elsewhere; the point is to
    // prove the helper is not a shortcut that diverges from init.ts.
    const mdConfig = presetToGroveMdConfig(
      { ...preset!, presetDescription: preset!.description },
      { name: "my-grove", description: preset!.description },
    );
    const viaPipeline = parseGroveContract(buildGroveMd(mdConfig));

    expect(viaHelper.name).toBe(viaPipeline.name);
    expect(viaHelper.mode).toBe(viaPipeline.mode);
    expect(viaHelper.contractVersion).toBe(viaPipeline.contractVersion);
    expect(viaHelper.topology?.structure).toBe(viaPipeline.topology?.structure);
    expect(viaHelper.topology?.roles.map((r) => r.name)).toEqual(
      viaPipeline.topology?.roles.map((r) => r.name) ?? [],
    );
    expect(viaHelper.topology?.spawning?.dynamic).toBe(viaPipeline.topology?.spawning?.dynamic);
    expect(viaHelper.concurrency?.maxActiveClaims).toBe(viaPipeline.concurrency?.maxActiveClaims);
    expect(viaHelper.execution?.defaultLeaseSeconds).toBe(
      viaPipeline.execution?.defaultLeaseSeconds,
    );
  });
});
