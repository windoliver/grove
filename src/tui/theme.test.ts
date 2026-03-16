/**
 * Tests for the theme system.
 *
 * Verifies that all expected tokens exist and have valid values.
 */

import { describe, expect, test } from "bun:test";
import { AGENT_COLORS, theme } from "./theme.js";

describe("theme", () => {
  test("has all focus/chrome tokens", () => {
    expect(theme.focus).toBeDefined();
    expect(theme.inactive).toBeDefined();
    expect(theme.border).toBeDefined();
  });

  test("has all status tokens", () => {
    expect(theme.running).toBeDefined();
    expect(theme.waiting).toBeDefined();
    expect(theme.idle).toBeDefined();
    expect(theme.error).toBeDefined();
    expect(theme.stale).toBeDefined();
  });

  test("has all contribution kind tokens", () => {
    expect(theme.work).toBeDefined();
    expect(theme.review).toBeDefined();
    expect(theme.discussion).toBeDefined();
    expect(theme.adoption).toBeDefined();
    expect(theme.reproduction).toBeDefined();
  });

  test("has all text tokens", () => {
    expect(theme.text).toBeDefined();
    expect(theme.muted).toBeDefined();
    expect(theme.dimmed).toBeDefined();
    expect(theme.disabled).toBeDefined();
  });

  test("has agent status symbols", () => {
    expect(theme.agentRunning).toBe("●");
    expect(theme.agentWaiting).toBe("◐");
    expect(theme.agentIdle).toBe("○");
    expect(theme.agentError).toBe("\u2717");
  });

  test("all color tokens are hex strings", () => {
    const hexRegex = /^#[0-9a-fA-F]{6}$/;
    for (const [key, value] of Object.entries(theme)) {
      if (
        typeof value === "string" &&
        key !== "agentRunning" &&
        key !== "agentWaiting" &&
        key !== "agentIdle" &&
        key !== "agentError"
      ) {
        expect(value).toMatch(hexRegex);
      }
    }
  });
});

describe("AGENT_COLORS", () => {
  test("has at least 4 colors", () => {
    expect(AGENT_COLORS.length).toBeGreaterThanOrEqual(4);
  });

  test("all entries are hex color strings", () => {
    const hexRegex = /^#[0-9a-fA-F]{6}$/;
    for (const color of AGENT_COLORS) {
      expect(color).toMatch(hexRegex);
    }
  });
});
