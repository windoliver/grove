import { describe, expect, test } from "bun:test";
import {
  buildApprovalsFromPrompts,
  permissionToApproval,
} from "./use-supervision-approvals.js";
import type { PermissionPrompt } from "../../hooks/use-agent-monitor.js";

const NOW = Date.parse("2026-05-15T12:00:00Z");

describe("permissionToApproval", () => {
  test("extracts agentId from grove- prefix", () => {
    const p: PermissionPrompt = {
      sessionName: "grove-a-001",
      agentRole: "coder",
      command: "rm -rf node_modules",
    };
    const a = permissionToApproval(p, NOW);
    expect(a.agentId).toBe("a-001");
    expect(a.requestId).toBe("grove-a-001");
    expect(a.kind).toBe("tmux-permission");
    expect(a.fullBody).toBe("rm -rf node_modules");
    expect(a.metadata).toEqual({ sessionName: "grove-a-001", agentRole: "coder" });
  });

  test("falls back to sessionName when prefix is missing", () => {
    const p: PermissionPrompt = {
      sessionName: "custom-session-x",
      agentRole: "scout",
      command: "do thing",
    };
    expect(permissionToApproval(p, NOW).agentId).toBe("custom-session-x");
  });

  test("truncates long command into prompt field", () => {
    const long = "x".repeat(100);
    const a = permissionToApproval(
      { sessionName: "grove-a-2", agentRole: "x", command: long },
      NOW,
    );
    expect(a.prompt.length).toBeLessThanOrEqual(40);
    expect(a.fullBody).toBe(long);
  });

  test("requestedAt is the injected nowMs", () => {
    const a = permissionToApproval(
      { sessionName: "grove-a-3", agentRole: "r", command: "c" },
      NOW,
    );
    expect(a.requestedAt).toBe(NOW);
  });
});

describe("buildApprovalsFromPrompts", () => {
  test("preserves first-seen-at across rebuilds (stable timestamp)", () => {
    const seen = new Map<string, number>();
    const first = buildApprovalsFromPrompts(
      [{ sessionName: "grove-a", agentRole: "r", command: "c1" }],
      seen,
      NOW,
    );
    expect(first[0].requestedAt).toBe(NOW);
    const later = buildApprovalsFromPrompts(
      [{ sessionName: "grove-a", agentRole: "r", command: "c1" }],
      seen,
      NOW + 60_000,
    );
    expect(later[0].requestedAt).toBe(NOW);
  });

  test("drops cache entries for prompts no longer present", () => {
    const seen = new Map<string, number>();
    buildApprovalsFromPrompts(
      [
        { sessionName: "grove-a", agentRole: "r", command: "c1" },
        { sessionName: "grove-b", agentRole: "r", command: "c2" },
      ],
      seen,
      NOW,
    );
    buildApprovalsFromPrompts(
      [{ sessionName: "grove-a", agentRole: "r", command: "c1" }],
      seen,
      NOW + 60_000,
    );
    expect(seen.has("grove-b")).toBe(false);
    expect(seen.has("grove-a")).toBe(true);
  });
});
