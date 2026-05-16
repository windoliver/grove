// src/tui/views/supervision/thresholds.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_THRESHOLDS, loadThresholds } from "./thresholds.js";

const SAVED_ENV: Record<string, string | undefined> = {};
const KEYS = [
  "GROVE_TUI_SUP_SILENT_MS",
  "GROVE_TUI_SUP_STUCK_MS",
  "GROVE_TUI_SUP_THRASH_WINDOW_MS",
  "GROVE_TUI_SUP_THRASH_CONTRIBS",
  "GROVE_TUI_SUP_COMPLETED_RETENTION_MS",
  "GROVE_TUI_SUP_COST_SPIKE_USD_PER_MIN",
  "GROVE_TUI_SUP_CONTEXT_PCT_WARN",
  "GROVE_TUI_SUP_CONTEXT_PCT_CRITICAL",
];

beforeEach(() => {
  for (const k of KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

describe("loadThresholds", () => {
  test("returns defaults when no env set and no overrides", () => {
    expect(loadThresholds()).toEqual(DEFAULT_THRESHOLDS);
  });

  test("env var overrides default", () => {
    process.env.GROVE_TUI_SUP_SILENT_MS = "30000";
    expect(loadThresholds().silentMs).toBe(30000);
  });

  test("config overrides beat env vars", () => {
    process.env.GROVE_TUI_SUP_SILENT_MS = "30000";
    expect(loadThresholds({ silentMs: 99 }).silentMs).toBe(99);
  });

  test("env overrides beat defaults but not explicit overrides", () => {
    process.env.GROVE_TUI_SUP_STUCK_MS = "12345";
    const t = loadThresholds();
    expect(t.stuckMs).toBe(12345);
    expect(t.silentMs).toBe(DEFAULT_THRESHOLDS.silentMs);
  });

  test("invalid env value falls back to default", () => {
    process.env.GROVE_TUI_SUP_THRASH_CONTRIBS = "not-a-number";
    expect(loadThresholds().thrashContribs).toBe(DEFAULT_THRESHOLDS.thrashContribs);
  });

  test("negative env value falls back to default", () => {
    process.env.GROVE_TUI_SUP_STUCK_MS = "-100";
    expect(loadThresholds().stuckMs).toBe(DEFAULT_THRESHOLDS.stuckMs);
  });
});
