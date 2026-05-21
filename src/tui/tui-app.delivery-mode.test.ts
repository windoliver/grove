import { describe, expect, test } from "bun:test";
import { shouldUseLocalContributionRoutingForMissingBridge } from "./tui-app.js";

describe("shouldUseLocalContributionRoutingForMissingBridge", () => {
  test("allows the local polling fallback only for local backends", () => {
    expect(shouldUseLocalContributionRoutingForMissingBridge("local")).toBe(true);
    expect(shouldUseLocalContributionRoutingForMissingBridge("remote")).toBe(false);
    expect(shouldUseLocalContributionRoutingForMissingBridge("nexus")).toBe(false);
    expect(shouldUseLocalContributionRoutingForMissingBridge(undefined)).toBe(false);
  });
});
