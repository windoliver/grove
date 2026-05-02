/**
 * WatchHubRecorder unit tests — verify each typed write maps to a
 * `WatchHub.recordWrite` call with the expected entity projection.
 */

import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../core/agent-runtime.js";
import type { Claim, Contribution } from "../core/models.js";
import type { EntityWriteEvent } from "../core/watch-events.js";
import { WatchHub } from "../core/watch-hub.js";
import { createWatchHubRecorder } from "./watch-hub-recorder.js";

const NS = "test-ns";

function captureRecorder(): {
  hub: WatchHub;
  events: EntityWriteEvent[];
} {
  const hub = new WatchHub();
  const events: EntityWriteEvent[] = [];
  const orig = hub.recordWrite.bind(hub);
  hub.recordWrite = (e: EntityWriteEvent) => {
    events.push(e);
    return orig(e);
  };
  return { hub, events };
}

describe("WatchHubRecorder", () => {
  test("contribution maps to ContributionEntity envelope", () => {
    const { hub, events } = captureRecorder();
    const recorder = createWatchHubRecorder({ hub, namespace: NS });
    const c: Contribution = {
      cid: "cid-1",
      manifestVersion: 1,
      kind: "review" as Contribution["kind"],
      mode: "report" as Contribution["mode"],
      summary: "test",
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "a-1" } as Contribution["agent"],
      createdAt: "2026-04-30T00:00:00Z",
    };

    recorder.contribution("ADDED", c);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("Contribution");
    expect(events[0]?.namespace).toBe(NS);
    expect(events[0]?.op).toBe("ADDED");
    expect(events[0]?.entity.kind).toBe("Contribution");
    expect(events[0]?.entity.id).toBe("cid-1");
  });

  test("claim maps to ClaimEntity envelope with injectable clock", () => {
    const { hub, events } = captureRecorder();
    const fixedNow = 1_700_000_000_000;
    const recorder = createWatchHubRecorder({ hub, namespace: NS, now: () => fixedNow });
    const claim: Claim = {
      claimId: "claim-1",
      targetRef: "target",
      agent: { agentId: "a-1" } as Claim["agent"],
      status: "active" as Claim["status"],
      intentSummary: "test",
      createdAt: "2026-04-30T00:00:00Z",
      heartbeatAt: "2026-04-30T00:00:00Z",
      leaseExpiresAt: "2099-04-30T00:00:00Z",
    };

    recorder.claim("MODIFIED", claim);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("Claim");
    expect(events[0]?.op).toBe("MODIFIED");
    expect(events[0]?.entity.id).toBe("claim-1");
    expect(events[0]?.entity.namespace).toBe(NS);
  });

  test("agentSession maps to AgentSessionEntity envelope", () => {
    const { hub, events } = captureRecorder();
    const recorder = createWatchHubRecorder({ hub, namespace: NS });
    const session: AgentSession = {
      id: "grove-coord-1-abc",
      role: "coordinator",
      status: "running",
    };

    recorder.agentSession("DELETED", session);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("AgentSession");
    expect(events[0]?.op).toBe("DELETED");
    expect(events[0]?.entity.id).toBe("grove-coord-1-abc");
    expect(events[0]?.entity.namespace).toBe(NS);
  });

  test("recordWrite throw is swallowed and logged, write loop continues", () => {
    const hub = new WatchHub();
    const errs: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((data: string | Uint8Array) => {
      errs.push(typeof data === "string" ? data : Buffer.from(data).toString("utf-8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      hub.recordWrite = () => {
        throw new Error("hub broken");
      };
      const recorder = createWatchHubRecorder({ hub, namespace: NS });
      const c: Contribution = {
        cid: "cid-x",
        manifestVersion: 1,
        kind: "review" as Contribution["kind"],
        mode: "report" as Contribution["mode"],
        summary: "",
        artifacts: {},
        relations: [],
        tags: [],
        agent: { agentId: "a" } as Contribution["agent"],
        createdAt: "2026-04-30T00:00:00Z",
      };
      // Must not throw.
      expect(() => recorder.contribution("ADDED", c)).not.toThrow();
      expect(errs.some((s) => s.includes("hub broken"))).toBe(true);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
