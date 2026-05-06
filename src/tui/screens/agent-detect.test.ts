import { describe, expect, test } from "bun:test";
import { detectCli } from "./agent-detect.js";

describe("AgentDetect CLI availability", () => {
  test("detects bundled ACP adapters even without shell shims", () => {
    expect(detectCli("claude")).toBe(true);
    expect(detectCli("codex")).toBe(true);
  });

  test("returns false for unsupported missing commands", () => {
    expect(detectCli("definitely-not-a-grove-agent")).toBe(false);
  });
});
