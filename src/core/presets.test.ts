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

  // Regression: an approving review must end the session in the SAME agent
  // turn. The reviewer is only triggered by the coder's push; after it
  // approves, its approval routes to the coder, NOT back to itself, so it
  // is never re-invoked. If the prompt defers grove_done to a "later step"
  // the reviewer submits the review, ends its turn, and the session hangs
  // `active` forever (only the reviewer may end it). See systematic debug
  // 2026-05-18: claude↔claude review-loop stalled at c=2 indefinitely.
  test("review-loop reviewer prompt forces grove_done in the same turn as an approving review", () => {
    const reviewerPrompt = getPreset("review-loop")?.topology?.roles?.find(
      (r) => r.name === "reviewer",
    )?.prompt;
    expect(reviewerPrompt).toBeDefined();
    const p = reviewerPrompt as string;
    // The fix: grove_done is co-located with approval as a same-turn,
    // mandatory action — not a deferred standalone step.
    expect(p).toContain("grove_done");
    expect(p).toContain("SAME response");
    expect(p.toLowerCase()).toContain("hang");
    // The buggy deferred phrasing must be gone.
    expect(p).not.toContain("When code meets standards, call grove_done");
  });
});
