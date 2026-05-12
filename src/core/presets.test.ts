import { describe, expect, test } from "bun:test";

import { getPreset } from "../cli/presets/index.js";
import { listPresetNames, lookupPresetTopology } from "./presets.js";

describe("core preset topology registry", () => {
  test("review-loop topology matches CLI preset topology", () => {
    const cliTopology = getPreset("review-loop")?.topology;
    const coreTopology = lookupPresetTopology("review-loop");

    expect(cliTopology).toBeDefined();
    expect(coreTopology).toEqual(cliTopology);
  });

  test("review-loop models coder to reviewer as the terminal handoff", () => {
    const topology = lookupPresetTopology("review-loop");
    const coder = topology?.roles.find((role) => role.name === "coder");
    const reviewer = topology?.roles.find((role) => role.name === "reviewer");

    expect(coder?.edges).toEqual([
      { target: "reviewer", edgeType: "delegates", replyTimeoutSeconds: 300 },
    ]);
    expect(reviewer?.edges).toBeUndefined();
  });

  test("lists known preset names", () => {
    expect(listPresetNames()).toContain("review-loop");
  });
});
