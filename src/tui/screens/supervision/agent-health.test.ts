import { describe, expect, test } from "bun:test";
import { deriveAgentHealth, HEALTH_THRESHOLDS, type HealthInput } from "./agent-health.js";

const NOW = new Date("2026-05-18T12:00:00Z").getTime();
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

function baseInput(over: Partial<HealthInput> = {}): HealthInput {
  return {
    role: "coder",
    leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
    heartbeatAt: minutesAgo(0),
    attemptCount: 0,
    lastRetryAt: undefined,
    lastOutputAt: minutesAgo(0),
    currentTask: "task-a",
    currentTaskSinceMs: 1_000,
    pendingApproval: undefined,
    blockedOn: undefined,
    blockedSinceMs: 0,
    agentFailure: undefined,
    ...over,
  };
}

describe("deriveAgentHealth", () => {
  test("agentFailure → error (highest priority)", () => {
    const out = deriveAgentHealth(
      baseInput({
        agentFailure: "auth failed",
        pendingApproval: { sessionName: "grove-coder-x", agentRole: "coder", command: "ls" },
      }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out).toEqual({ kind: "error", reason: "auth failed" });
  });

  test("pendingApproval beats blocked beats stuck", () => {
    const out = deriveAgentHealth(
      baseInput({
        pendingApproval: { sessionName: "s", agentRole: "coder", command: "rm" },
      }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out).toEqual({ kind: "approval", cmd: "rm" });
  });

  test("lease expired → expired", () => {
    const out = deriveAgentHealth(
      baseInput({ leaseExpiresAt: new Date(NOW - 1).toISOString() }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out.kind).toBe("expired");
  });

  test("attemptCount >= threshold and recent retry → thrashing", () => {
    const out = deriveAgentHealth(
      baseInput({ attemptCount: 4, lastRetryAt: new Date(NOW - 10_000).toISOString() }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out).toEqual({ kind: "thrashing", retries: 4 });
  });

  test("blockedOn set and past min duration → blocked", () => {
    const out = deriveAgentHealth(
      baseInput({ blockedOn: "coordinator", blockedSinceMs: 120_000 }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out).toEqual({ kind: "blocked", on: "coordinator", sinceMs: 120_000 });
  });

  test("no output for > SILENT_MS → silent", () => {
    const out = deriveAgentHealth(
      baseInput({ lastOutputAt: minutesAgo(6) }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out.kind).toBe("silent");
  });

  test("task unchanged longer than STUCK_MS but output recent → stuck", () => {
    const out = deriveAgentHealth(
      baseInput({ currentTaskSinceMs: 9 * 60_000, lastOutputAt: minutesAgo(0) }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out.kind).toBe("stuck");
  });

  test("heartbeat lapse > 60s → silent (heartbeat path)", () => {
    const out = deriveAgentHealth(
      baseInput({ heartbeatAt: minutesAgo(2), lastOutputAt: minutesAgo(0) }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out.kind).toBe("silent");
  });

  test("recent output + recent heartbeat → running", () => {
    const out = deriveAgentHealth(baseInput(), NOW, HEALTH_THRESHOLDS);
    expect(out.kind).toBe("running");
  });

  test("no output ever + no task → idle", () => {
    const out = deriveAgentHealth(
      baseInput({ lastOutputAt: undefined, currentTask: undefined }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out.kind).toBe("idle");
  });

  test("threshold edge: SILENT_MS - 1 → not silent", () => {
    const out = deriveAgentHealth(
      baseInput({ lastOutputAt: new Date(NOW - HEALTH_THRESHOLDS.silentMs + 1).toISOString() }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out.kind).not.toBe("silent");
  });
});
