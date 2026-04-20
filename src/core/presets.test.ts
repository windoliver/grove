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

  test("lists known preset names", () => {
    expect(listPresetNames()).toContain("review-loop");
  });
});
