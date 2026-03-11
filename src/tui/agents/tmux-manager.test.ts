/**
 * Tests for TmuxManager — uses MockTmuxManager for unit tests.
 */

import { describe, expect, test } from "bun:test";
import { agentIdFromSession, MockTmuxManager, tmuxSessionName } from "./tmux-manager.js";

describe("tmuxSessionName", () => {
  test("prefixes with grove-", () => {
    expect(tmuxSessionName("claude-1")).toBe("grove-claude-1");
    expect(tmuxSessionName("codex-2")).toBe("grove-codex-2");
  });
});

describe("agentIdFromSession", () => {
  test("extracts agentId from grove- prefix", () => {
    expect(agentIdFromSession("grove-claude-1")).toBe("claude-1");
    expect(agentIdFromSession("grove-codex-2")).toBe("codex-2");
  });

  test("returns undefined for non-grove sessions", () => {
    expect(agentIdFromSession("random-session")).toBeUndefined();
    expect(agentIdFromSession("")).toBeUndefined();
  });
});

describe("MockTmuxManager", () => {
  test("spawn and list sessions", async () => {
    const mgr = new MockTmuxManager();
    await mgr.spawn({
      agentId: "claude-1",
      command: "claude",
      targetRef: "src/auth",
      workspacePath: "/tmp/ws",
    });

    const sessions = await mgr.listSessions();
    expect(sessions).toEqual(["grove-claude-1"]);
  });

  test("kill removes session", async () => {
    const mgr = new MockTmuxManager();
    await mgr.spawn({
      agentId: "claude-1",
      command: "claude",
      targetRef: "src/auth",
      workspacePath: "/tmp/ws",
    });

    await mgr.kill("grove-claude-1");
    const sessions = await mgr.listSessions();
    expect(sessions).toEqual([]);
  });

  test("capturePanes returns mock output", async () => {
    const mgr = new MockTmuxManager();
    await mgr.spawn({
      agentId: "claude-1",
      command: "claude",
      targetRef: "src/auth",
      workspacePath: "/tmp/ws",
    });

    mgr.setOutput("grove-claude-1", "Hello from agent\n");
    const output = await mgr.capturePanes("grove-claude-1");
    expect(output).toBe("Hello from agent\n");
  });

  test("isAvailable returns true by default", async () => {
    const mgr = new MockTmuxManager();
    expect(await mgr.isAvailable()).toBe(true);
  });

  test("setAvailable controls availability", async () => {
    const mgr = new MockTmuxManager();
    mgr.setAvailable(false);
    expect(await mgr.isAvailable()).toBe(false);
  });

  test("multiple agents", async () => {
    const mgr = new MockTmuxManager();
    await mgr.spawn({
      agentId: "claude-1",
      command: "claude",
      targetRef: "src/auth",
      workspacePath: "/tmp/ws1",
    });
    await mgr.spawn({
      agentId: "codex-2",
      command: "codex",
      targetRef: "src/db",
      workspacePath: "/tmp/ws2",
    });

    const sessions = await mgr.listSessions();
    expect(sessions.length).toBe(2);
    expect(sessions).toContain("grove-claude-1");
    expect(sessions).toContain("grove-codex-2");
  });
});
