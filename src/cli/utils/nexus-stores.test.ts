/**
 * Tests for the CLI Nexus store resolver.
 *
 * resolveNexusParams decides whether a grove dir has reachable Nexus-backed
 * stores. Driven here purely via env vars + a nonexistent grove dir (so no
 * nexus.yaml / namespace file is read), which exercises the env-override paths.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveNexusParams } from "./nexus-stores.js";

const NONEXISTENT = "/nonexistent/.grove";
const ENV_KEYS = ["GROVE_NEXUS_URL", "NEXUS_API_KEY", "GROVE_ZONE_ID", "GROVE_SESSION_ID"] as const;

describe("resolveNexusParams", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("returns undefined when no Nexus URL is available", () => {
    process.env.GROVE_ZONE_ID = "proj/wt";
    expect(resolveNexusParams(NONEXISTENT, "/nonexistent")).toBeUndefined();
  });

  test("returns undefined when a URL exists but no zone can be resolved", () => {
    process.env.GROVE_NEXUS_URL = "http://localhost:14939";
    expect(resolveNexusParams(NONEXISTENT, "/nonexistent")).toBeUndefined();
  });

  test("returns params when URL and zone are both available", () => {
    process.env.GROVE_NEXUS_URL = "http://localhost:14939";
    process.env.GROVE_ZONE_ID = "proj/wt";
    process.env.NEXUS_API_KEY = "grv_secret";
    expect(resolveNexusParams(NONEXISTENT, "/nonexistent")).toEqual({
      url: "http://localhost:14939",
      apiKey: "grv_secret",
      zoneId: "proj/wt",
    });
  });

  test("includes sessionId when GROVE_SESSION_ID is set", () => {
    process.env.GROVE_NEXUS_URL = "http://localhost:14939";
    process.env.GROVE_ZONE_ID = "proj/wt";
    process.env.GROVE_SESSION_ID = "sess-123";
    const params = resolveNexusParams(NONEXISTENT, "/nonexistent");
    expect(params?.sessionId).toBe("sess-123");
  });

  test("omits apiKey when none is configured", () => {
    process.env.GROVE_NEXUS_URL = "http://localhost:14939";
    process.env.GROVE_ZONE_ID = "proj/wt";
    const params = resolveNexusParams(NONEXISTENT, "/nonexistent");
    expect(params).toBeDefined();
    expect(params).not.toHaveProperty("apiKey");
  });
});
