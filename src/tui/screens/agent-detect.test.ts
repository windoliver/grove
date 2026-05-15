import { describe, expect, test } from "bun:test";
import { detectCli } from "./agent-cli-detect.js";
import { matchesKey } from "./key-match.js";

describe("AgentDetect CLI availability", () => {
  test("detects bundled ACP adapters even without shell shims", () => {
    expect(detectCli("claude")).toBe(true);
    expect(detectCli("codex")).toBe(true);
  });

  test("returns false for unsupported missing commands", () => {
    expect(detectCli("definitely-not-a-grove-agent", { which: () => null })).toBe(false);
  });

  test("uses injected command lookup for deterministic unsupported command tests", () => {
    expect(detectCli("sh", { which: () => null })).toBe(false);
  });
});

describe("AgentDetect keyboard matching", () => {
  test("matches printable letter keys reported as sequence-only events", () => {
    expect(matchesKey({ sequence: "c" }, "c")).toBe(true);
  });

  test("matches named control keys", () => {
    expect(matchesKey({ name: "escape" }, "escape")).toBe(true);
  });
});
