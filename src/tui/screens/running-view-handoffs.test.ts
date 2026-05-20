import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Handoff, HandoffStatus } from "../../core/handoff.js";
import type { TuiDataProvider } from "../provider.js";
import { loadHandoffPanelSnapshot } from "./running-view.js";

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
});
