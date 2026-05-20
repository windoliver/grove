import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentTaskPhase, type AgentTaskView } from "../../core/agent-task.js";
import { type Handoff, HandoffStatus } from "../../core/handoff.js";
import type { TuiDataProvider } from "../provider.js";
import { loadHandoffPanelSnapshot } from "./running-view.js";

function agentTask(role: string, sessionId: string, phase: AgentTaskPhase): AgentTaskView {
  return {
    spec: {
      id: `${role}-${sessionId}`,
      worktree: "/tmp/worktree",
      runtime: "codex",
      role,
      prompt: "Review the change",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-20T10:00:00.000Z",
    },
    status: {
      id: `${role}-${sessionId}`,
      phase,
      sessionId,
      contributions: [],
      conditions: [],
      observedGeneration: 1,
      lastTransitionAt: "2026-05-20T10:01:00.000Z",
      revision: 1,
    },
  };
}

describe("RunningView handoff refresh wiring", () => {
  test("refetches handoffs when the contribution feed changes", () => {
    const source = readFileSync(resolve(import.meta.dir, "running-view.tsx"), "utf-8");

    expect(source).toContain("const refreshHandoffs = useCallback");
    expect(source).toContain("feedCidKey");
    expect(source).toContain("[feedCidKey, refreshHandoffs]");
    expect(source).toContain("healthSignalsFromAgentFailures");
    expect(source).toContain("healthSignalsFromAgentTasks");
    expect(source).toContain("handoffHealthSignals");
  });

  test("keeps handoffs fresh when agent task health fetch fails", async () => {
    const handoff: Handoff = {
      handoffId: "handoff-visible",
      sourceCid: "blake3:visible",
      fromRole: "coder",
      toRole: "reviewer",
      status: HandoffStatus.Delivered,
      requiresReply: true,
      createdAt: "2099-01-01T00:00:00.000Z",
    };
    const provider = {
      getHandoffs: async () => [handoff],
      getAgentTasks: async () => {
        throw new Error("agent task route unavailable");
      },
      markHandoffDelivered: async () => undefined,
      cancelHandoff: async () => undefined,
      manualResolveHandoff: async () => undefined,
      resendHandoff: async () => undefined,
      rerouteHandoff: async () => undefined,
    } as unknown as TuiDataProvider;

    const snapshot = await loadHandoffPanelSnapshot({
      provider,
      agentFailures: new Map([["reviewer", "bootstrap failed"]]),
    });

    expect(snapshot.handoffs).toEqual([handoff]);
    expect(snapshot.healthSignals).toEqual([
      { role: "reviewer", healthy: false, reason: "bootstrap failed" },
    ]);
  });

  test("ignores agent task health from other sessions", async () => {
    const handoff: Handoff = {
      handoffId: "handoff-session-a",
      sourceCid: "blake3:session-a",
      fromRole: "coder",
      toRole: "reviewer",
      status: HandoffStatus.Delivered,
      requiresReply: true,
      createdAt: "2099-01-01T00:00:00.000Z",
    };
    const provider = {
      getHandoffs: async () => [handoff],
      getAgentTasks: async () => [agentTask("reviewer", "session-b", AgentTaskPhase.Failed)],
      markHandoffDelivered: async () => undefined,
      cancelHandoff: async () => undefined,
      manualResolveHandoff: async () => undefined,
      resendHandoff: async () => undefined,
      rerouteHandoff: async () => undefined,
    } as unknown as TuiDataProvider;

    const snapshot = await loadHandoffPanelSnapshot({
      provider,
      sessionId: "session-a",
    });

    expect(snapshot.handoffs).toEqual([handoff]);
    expect(snapshot.healthSignals).toEqual([]);
  });
});
