/**
 * Tests for agent monitor parsing functions.
 *
 * The useAgentMonitor hook uses React state (useState/useEffect) so it
 * can't be unit-tested directly. Instead, we test the pure parsing
 * functions that the hook delegates to:
 *   - isLogLineKept: log line filtering
 *   - roleFromLogFilename: "coder-0.log" → "coder"
 *   - roleFromSessionName: "grove-coder-abc123" → "coder"
 *   - parsePermissionPrompt: detects "Do you want to proceed" + extracts command
 *   - parseLogContent: full pipeline (filter + strip ANSI + truncate)
 */

import { describe, expect, test } from "bun:test";
import {
  isLogLineKept,
  parseLogContent,
  parsePermissionPrompt,
  roleFromLogFilename,
  roleFromSessionName,
} from "./use-agent-monitor.js";

// ===========================================================================
// isLogLineKept
// ===========================================================================

describe("isLogLineKept", () => {
  test("keeps normal output lines", () => {
    expect(isLogLineKept("Working on file src/main.ts")).toBe(true);
    expect(isLogLineKept("  indented output")).toBe(true);
    expect(isLogLineKept("error: something broke")).toBe(true);
  });

  test("rejects empty lines", () => {
    expect(isLogLineKept("")).toBe(false);
    expect(isLogLineKept("   ")).toBe(false);
    expect(isLogLineKept("\t\t")).toBe(false);
  });

  test("rejects stderr markers", () => {
    expect(isLogLineKept("[stderr] some warning")).toBe(false);
  });

  test("rejects timestamp-only lines", () => {
    expect(isLogLineKept("[2026-03-27T10:30:00.000Z] init")).toBe(false);
    expect(isLogLineKept("[20xx-test")).toBe(false);
  });

  test("rejects prompt injection markers", () => {
    expect(isLogLineKept(">>> PROMPT injected")).toBe(false);
    expect(isLogLineKept("<<< END PROMPT")).toBe(false);
  });

  test("rejects status markers", () => {
    expect(isLogLineKept("=== IDLE since 10:30")).toBe(false);
    expect(isLogLineKept("=== CRASHED at 10:31")).toBe(false);
    expect(isLogLineKept("=== Session started")).toBe(false);
  });

  test("rejects lines that contain status markers anywhere (.includes)", () => {
    // .includes matches mid-line too — this is intentional to catch log output
    expect(isLogLineKept("agent status === IDLE")).toBe(false);
    expect(isLogLineKept("checking === CRASHED state")).toBe(false);
    expect(isLogLineKept("=== Session resumed")).toBe(false);
  });
});

// ===========================================================================
// roleFromLogFilename
// ===========================================================================

describe("roleFromLogFilename", () => {
  test("strips .log extension", () => {
    expect(roleFromLogFilename("coder.log")).toBe("coder");
  });

  test("strips numeric suffix and extension", () => {
    expect(roleFromLogFilename("coder-0.log")).toBe("coder");
    expect(roleFromLogFilename("coder-12.log")).toBe("coder");
    expect(roleFromLogFilename("reviewer-3.log")).toBe("reviewer");
  });

  test("handles multi-part role names", () => {
    expect(roleFromLogFilename("code-reviewer-0.log")).toBe("code-reviewer");
    expect(roleFromLogFilename("senior-dev-2.log")).toBe("senior-dev");
  });

  test("handles names without numeric suffix", () => {
    expect(roleFromLogFilename("coder.log")).toBe("coder");
    expect(roleFromLogFilename("single-agent.log")).toBe("single-agent");
  });
});

// ===========================================================================
// roleFromSessionName
// ===========================================================================

describe("roleFromSessionName", () => {
  test("strips grove- prefix and trailing id", () => {
    expect(roleFromSessionName("grove-coder-abc123")).toBe("coder");
    expect(roleFromSessionName("grove-reviewer-xyz789")).toBe("reviewer");
  });

  test("handles multi-part role names", () => {
    expect(roleFromSessionName("grove-code-reviewer-abc123")).toBe("code-reviewer");
  });

  test("handles numeric trailing IDs", () => {
    expect(roleFromSessionName("grove-coder-12345")).toBe("coder");
  });

  test("handles uppercase in trailing ID", () => {
    expect(roleFromSessionName("grove-coder-AbC123")).toBe("coder");
  });
});

// ===========================================================================
// parsePermissionPrompt
// ===========================================================================

describe("parsePermissionPrompt", () => {
  test("returns null when no permission prompt detected", () => {
    expect(parsePermissionPrompt("Normal agent output\nDoing work\n")).toBeNull();
    expect(parsePermissionPrompt("")).toBeNull();
  });

  test("detects permission prompt and extracts command", () => {
    const pane = [
      "Permission required for tool use",
      "rm -rf /tmp/test-dir",
      "Do you want to proceed?",
      "\u276f Yes",
      "Esc to cancel",
    ].join("\n");
    const cmd = parsePermissionPrompt(pane);
    expect(cmd).toBe("rm -rf /tmp/test-dir");
  });

  test("extracts the last non-filtered line as command", () => {
    const pane = [
      "Some context line",
      "git push --force origin main",
      "Do you want to proceed?",
    ].join("\n");
    expect(parsePermissionPrompt(pane)).toBe("git push --force origin main");
  });

  test("truncates command to 80 chars", () => {
    const longCmd = "a".repeat(100);
    const pane = `${longCmd}\nDo you want to proceed?\n`;
    const cmd = parsePermissionPrompt(pane);
    expect(cmd?.length).toBe(80);
  });

  test("filters out Permission/Do you/❯/Esc prefixed lines", () => {
    const pane = [
      "Permission: write to filesystem",
      "Do you want to proceed?",
      "❯ Allow",
      "Esc to deny",
    ].join("\n");
    // All lines are filtered, so cmd should be empty string
    expect(parsePermissionPrompt(pane)).toBe("");
  });

  test("handles empty lines in pane output", () => {
    const pane = [
      "",
      "npm install express",
      "",
      "Do you want to proceed?",
      "",
    ].join("\n");
    expect(parsePermissionPrompt(pane)).toBe("npm install express");
  });
});

// ===========================================================================
// parseLogContent
// ===========================================================================

describe("parseLogContent", () => {
  test("filters noise and strips ANSI from log content", () => {
    const content = [
      "[2026-03-27T10:00:00Z] init",
      "\x1b[32mWorking on auth\x1b[0m",
      "[stderr] some warning",
      "Completed auth module",
      ">>> PROMPT injected",
      "",
    ].join("\n");
    const lines = parseLogContent(content, 8);
    expect(lines).toEqual(["Working on auth", "Completed auth module"]);
  });

  test("respects maxLines limit", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const lines = parseLogContent(content, 5);
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe("line 15");
    expect(lines[4]).toBe("line 19");
  });

  test("handles empty content", () => {
    expect(parseLogContent("", 8)).toEqual([]);
  });

  test("handles content with only noise", () => {
    const content = "[stderr] warning\n[2026-01-01T00:00:00Z] start\n>>> PROMPT\n";
    expect(parseLogContent(content, 8)).toEqual([]);
  });

  test("strips complex ANSI sequences", () => {
    const content = "\x1b[1;31mError:\x1b[0m something failed\n";
    const lines = parseLogContent(content, 8);
    expect(lines).toEqual(["Error: something failed"]);
  });

  test("strips OSC sequences (terminal titles)", () => {
    const content = "\x1b]0;my-terminal\x07Actual output\n";
    const lines = parseLogContent(content, 8);
    expect(lines).toEqual(["Actual output"]);
  });
});
