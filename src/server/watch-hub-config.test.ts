import { describe, expect, mock, test } from "bun:test";
import { resolveWatchHubConfig } from "./watch-hub-config.js";

describe("resolveWatchHubConfig", () => {
  test("returns defaults when no env vars set", () => {
    const cfg = resolveWatchHubConfig({});
    expect(cfg.maxAgeMsPerKey).toBe(300_000);
    expect(cfg.maxEventsPerKey).toBe(1024);
  });

  test("reads GROVE_WATCH_RETENTION_MS when in range", () => {
    const cfg = resolveWatchHubConfig({
      GROVE_WATCH_RETENTION_MS: "30000",
    });
    expect(cfg.maxAgeMsPerKey).toBe(30_000);
  });

  test("reads GROVE_WATCH_MAX_EVENTS when in range", () => {
    const cfg = resolveWatchHubConfig({
      GROVE_WATCH_MAX_EVENTS: "256",
    });
    expect(cfg.maxEventsPerKey).toBe(256);
  });

  test("clamps GROVE_WATCH_RETENTION_MS below min to default", () => {
    const warn = mock(() => {});
    const cfg = resolveWatchHubConfig({ GROVE_WATCH_RETENTION_MS: "0" }, { warn });
    expect(cfg.maxAgeMsPerKey).toBe(300_000);
    expect(warn.mock.calls.length).toBe(1);
  });

  test("clamps GROVE_WATCH_MAX_EVENTS above max to default", () => {
    const warn = mock(() => {});
    const cfg = resolveWatchHubConfig({ GROVE_WATCH_MAX_EVENTS: "9999999999" }, { warn });
    expect(cfg.maxEventsPerKey).toBe(1024);
    expect(warn.mock.calls.length).toBe(1);
  });

  test("rejects negative GROVE_WATCH_RETENTION_MS", () => {
    const warn = mock(() => {});
    const cfg = resolveWatchHubConfig({ GROVE_WATCH_RETENTION_MS: "-5" }, { warn });
    expect(cfg.maxAgeMsPerKey).toBe(300_000);
  });

  test("accepts boundary values", () => {
    const cfg = resolveWatchHubConfig({
      GROVE_WATCH_RETENTION_MS: "1000", // min
      GROVE_WATCH_MAX_EVENTS: "1000000", // max
    });
    expect(cfg.maxAgeMsPerKey).toBe(1000);
    expect(cfg.maxEventsPerKey).toBe(1_000_000);
  });
});
