import { describe, expect, test } from "bun:test";
import type { ClaimEntity } from "../../../core/entity.js";
import { type Handoff, HandoffStatus } from "../../../core/handoff.js";
import { buildFleet, type FleetSources } from "./use-fleet-model.js";

const NOW = new Date("2026-05-18T12:00:00Z").getTime();

function claim(
  agentId: string,
  role: string,
  over: Partial<ClaimEntity["status"]> = {},
): ClaimEntity {
  return {
    kind: "Claim",
    id: `claim-${agentId}`,
    namespace: "default",
    conditions: [],
    observedGeneration: 1,
    resourceVersion: "1",
    metadata: { generation: 1, creationTimestamp: new Date(NOW - 60_000).toISOString() },
    spec: {
      agent: { agentId, agentName: agentId, role, platform: "claude" },
      targetRef: `target-${agentId}`,
      intentSummary: "do thing",
      context: {},
    },
    status: {
      phase: "active",
      persistedPhase: "active",
      heartbeatAt: new Date(NOW).toISOString(),
      lastHeartbeatAt: new Date(NOW).toISOString(),
      leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
      observedGeneration: 1,
      attemptCount: 0,
      ...over,
    },
  } as ClaimEntity;
}

const baseSources: FleetSources = {
  claims: [],
  tmuxSessions: [],
  costs: new Map(),
  agentOutputs: new Map(),
  agentOutputTimestamps: new Map(),
  pendingPermissions: [],
  handoffs: [],
  agentFailures: new Map(),
  filterText: undefined,
  nowMs: NOW,
};

describe("buildFleet", () => {
  test("sorts problem agents before running agents", () => {
    const fleet = buildFleet({
      ...baseSources,
      claims: [claim("a-run", "coder"), claim("b-fail", "coder")],
      agentFailures: new Map([["b-fail", "ACP auth failed"]]),
    });
    expect(fleet[0]?.agentId).toBe("b-fail");
    expect(fleet[0]?.health.kind).toBe("error");
  });

  test("session field undefined when no tmux session matches", () => {
    const fleet = buildFleet({
      ...baseSources,
      claims: [claim("a", "coder")],
      tmuxSessions: ["grove-other-xyz"],
    });
    expect(fleet[0]?.session).toBeUndefined();
  });

  test("cost rollup matches by agentId", () => {
    const fleet = buildFleet({
      ...baseSources,
      claims: [claim("a", "coder")],
      costs: new Map([["a", { usd: 1.23, tokens: 4567 }]]),
    });
    expect(fleet[0]?.cost?.usd).toBe(1.23);
  });

  test("filterText narrows by case-insensitive substring across role/name/target", () => {
    const fleet = buildFleet({
      ...baseSources,
      claims: [claim("alpha", "coder"), claim("beta", "reviewer")],
      filterText: "REV",
    });
    expect(fleet.map((f) => f.agentId)).toEqual(["beta"]);
  });

  test("handoff blockedOn aggregated from oldest pending inbound", () => {
    const handoff = {
      handoffId: "h1",
      fromRole: "coordinator",
      toRole: "coder",
      status: HandoffStatus.PendingPickup,
      sourceCid: "cid-1",
      requiresReply: false,
      createdAt: new Date(NOW - 5 * 60_000).toISOString(),
    } as Handoff;
    const fleet = buildFleet({
      ...baseSources,
      claims: [claim("a", "coder")],
      handoffs: [handoff],
    });
    expect(fleet[0]?.handoffs.blockedOn).toBe("coordinator");
  });
});
