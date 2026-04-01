/**
 * Tests for topology resolution precedence and error handling.
 */

import { describe, expect, test } from "bun:test";
import type { AgentTopology } from "./topology.js";
import {
  type PresetLookup,
  resolveTopology,
  type TopologyResolutionInput,
} from "./topology-resolver.js";

// ---------------------------------------------------------------------------
// Fixtures — minimal but valid AgentTopology objects
// ---------------------------------------------------------------------------

const inlineTopology: AgentTopology = {
  structure: "flat",
  roles: [{ name: "inline-worker" }],
};

const presetTopology: AgentTopology = {
  structure: "graph",
  roles: [
    { name: "coder", edges: [{ target: "reviewer", edgeType: "delegates" }] },
    { name: "reviewer", edges: [{ target: "coder", edgeType: "feedback" }] },
  ],
};

const contractTopology: AgentTopology = {
  structure: "tree",
  roles: [
    { name: "coordinator", edges: [{ target: "worker", edgeType: "delegates" }] },
    { name: "worker" },
  ],
};

/** Lookup that knows about the "default" preset only. */
const knownPresetLookup: PresetLookup = (name: string) => {
  if (name === "default") return presetTopology;
  return undefined;
};

// ---------------------------------------------------------------------------
// 1. Inline topology wins over everything
// ---------------------------------------------------------------------------

describe("inline topology wins over everything", () => {
  test("inline only returns inline, source='inline'", () => {
    const result = resolveTopology({ inlineTopology });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.topology).toBe(inlineTopology);
    expect(result.source).toBe("inline");
  });

  test("inline + preset returns inline, source='inline'", () => {
    const result = resolveTopology({ inlineTopology, presetName: "default" }, knownPresetLookup);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.topology).toBe(inlineTopology);
    expect(result.source).toBe("inline");
  });

  test("inline + contract default returns inline, source='inline'", () => {
    const result = resolveTopology({
      inlineTopology,
      contractDefault: contractTopology,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.topology).toBe(inlineTopology);
    expect(result.source).toBe("inline");
  });

  test("inline + preset + contract default returns inline, source='inline'", () => {
    const result = resolveTopology(
      {
        inlineTopology,
        presetName: "default",
        contractDefault: contractTopology,
      },
      knownPresetLookup,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.topology).toBe(inlineTopology);
    expect(result.source).toBe("inline");
  });
});

// ---------------------------------------------------------------------------
// 2. Preset beats contract default
// ---------------------------------------------------------------------------

describe("preset beats contract default", () => {
  test("preset only returns preset topology, source='preset'", () => {
    const result = resolveTopology({ presetName: "default" }, knownPresetLookup);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.topology).toBe(presetTopology);
    expect(result.source).toBe("preset");
  });

  test("preset + contract default returns preset, source='preset'", () => {
    const result = resolveTopology(
      { presetName: "default", contractDefault: contractTopology },
      knownPresetLookup,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.topology).toBe(presetTopology);
    expect(result.source).toBe("preset");
  });
});

// ---------------------------------------------------------------------------
// 3. Contract default is fallback
// ---------------------------------------------------------------------------

describe("contract default is fallback", () => {
  test("contract default only returns contract, source='contract'", () => {
    const result = resolveTopology({ contractDefault: contractTopology });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.topology).toBe(contractTopology);
    expect(result.source).toBe("contract");
  });
});

// ---------------------------------------------------------------------------
// 4. Error cases
// ---------------------------------------------------------------------------

describe("error cases", () => {
  test("no inputs at all returns error with descriptive message", () => {
    const result = resolveTopology({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("No topology available");
    expect(result.error).toContain("--preset");
    expect(result.error).toContain("GROVE.md");
  });

  test("preset name but no lookup function returns error", () => {
    const result = resolveTopology({ presetName: "default" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("no preset registry available");
    expect(result.error).toContain("default");
  });

  test("preset name but lookup returns undefined (unknown preset) includes preset name in error", () => {
    const result = resolveTopology({ presetName: "nonexistent-preset" }, knownPresetLookup);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("Unknown preset");
    expect(result.error).toContain("nonexistent-preset");
  });

  test("undefined preset name + no contract default returns error", () => {
    const input: TopologyResolutionInput = {
      presetName: undefined,
      contractDefault: undefined,
    };
    const result = resolveTopology(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("No topology available");
  });
});

// ---------------------------------------------------------------------------
// 5. Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("all fields explicitly undefined returns error", () => {
    const result = resolveTopology({
      inlineTopology: undefined,
      presetName: undefined,
      contractDefault: undefined,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("No topology available");
  });

  test("lookup function is NOT called when inline topology is provided", () => {
    let lookupCalled = false;
    const spy: PresetLookup = (_name: string) => {
      lookupCalled = true;
      return presetTopology;
    };

    const result = resolveTopology({ inlineTopology, presetName: "default" }, spy);
    expect(result.ok).toBe(true);
    expect(lookupCalled).toBe(false);
  });

  test("lookup function IS called exactly when presetName is provided", () => {
    let lookupCalledWith: string | undefined;
    const spy: PresetLookup = (name: string) => {
      lookupCalledWith = name;
      return presetTopology;
    };

    const result = resolveTopology({ presetName: "my-preset" }, spy);
    expect(result.ok).toBe(true);
    expect(lookupCalledWith).toBe("my-preset");
  });

  test("preset lookup receives the exact preset name string", () => {
    const receivedNames: string[] = [];
    const collectingLookup: PresetLookup = (name: string) => {
      receivedNames.push(name);
      return presetTopology;
    };

    resolveTopology({ presetName: "fancy-topology" }, collectingLookup);
    expect(receivedNames).toEqual(["fancy-topology"]);
  });

  test("result topology is the exact same object reference (no cloning)", () => {
    const result = resolveTopology({ inlineTopology });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // Strict identity check — resolver must not clone
    expect(result.topology === inlineTopology).toBe(true);
  });

  test("preset lookup returning a topology is passed through by reference", () => {
    const result = resolveTopology({ presetName: "default" }, knownPresetLookup);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.topology === presetTopology).toBe(true);
  });

  test("contract default topology is passed through by reference", () => {
    const result = resolveTopology({ contractDefault: contractTopology });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.topology === contractTopology).toBe(true);
  });
});
