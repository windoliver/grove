import { describe, expect, test } from "bun:test";
import { ClaimStatus } from "../core/models.js";
import { InMemoryClaimStore } from "./test-helpers.js";

describe("InMemoryClaimStore split claim methods", () => {
  test("putClaimSpec creates default status from spec lease deadline", async () => {
    const store = new InMemoryClaimStore();

    const view = await store.putClaimSpec({
      id: "split-create",
      targetRef: "target-split",
      agent: { agentId: "agent-split" },
      intentSummary: "create split claim",
      createdAt: "2026-01-01T00:00:00.000Z",
      leaseDeadlineSec: 120,
      generation: 99,
    });

    expect(view.spec.generation).toBe(1);
    expect(view.status.phase).toBe(ClaimStatus.Active);
    expect(view.status.observedGeneration).toBe(0);
    expect(view.status.leaseExpiresAt).toBe("2026-01-01T00:02:00.000Z");
    expect(view.status.conditions).toEqual([]);
    expect(view.status.attemptCount).toBe(0);
    expect(view.status.revision).toBe(1);
  });

  test("putClaimSpec update preserves original createdAt and current status", async () => {
    const store = new InMemoryClaimStore();

    const created = await store.putClaimSpec({
      id: "split-update",
      targetRef: "target-split",
      agent: { agentId: "agent-split" },
      intentSummary: "first intent",
      createdAt: "2026-01-01T00:00:00.000Z",
      generation: 1,
    });
    const patched = await store.patchClaimStatus("split-update", {
      phase: ClaimStatus.Completed,
      observedGeneration: created.spec.generation,
      lastHeartbeatAt: "2026-01-01T00:05:00.000Z",
      leaseExpiresAt: "2026-01-01T00:10:00.000Z",
      lastTransitionAt: "2026-01-01T00:05:00.000Z",
    });

    const updated = await store.putClaimSpec({
      ...created.spec,
      intentSummary: "second intent",
      createdAt: "2026-02-01T00:00:00.000Z",
      generation: 99,
    });

    expect(updated.spec.createdAt).toBe(created.spec.createdAt);
    expect(updated.spec.generation).toBe(created.spec.generation + 1);
    expect(updated.spec.intentSummary).toBe("second intent");
    expect(updated.status).toEqual(patched.status);
  });

  test("patchClaimStatus merges split-only fields while preserving spec", async () => {
    const store = new InMemoryClaimStore();
    const created = await store.putClaimSpec({
      id: "split-status",
      targetRef: "target-split",
      agent: { agentId: "agent-split" },
      intentSummary: "status patch",
      createdAt: "2026-01-01T00:00:00.000Z",
      generation: 1,
    });

    const patched = await store.patchClaimStatus("split-status", {
      phase: ClaimStatus.Active,
      observedGeneration: 7,
      agentSessionId: "session-1",
      lastHeartbeatAt: "2026-01-01T00:03:00.000Z",
      leaseExpiresAt: "2026-01-01T00:08:00.000Z",
      currentContributionCid:
        "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      conditions: [
        {
          type: "Ready",
          status: "True",
          observedGeneration: 7,
          lastTransitionTime: "2026-01-01T00:03:00.000Z",
          reason: "Heartbeat",
          message: "claim heartbeat observed",
        },
      ],
      lastTransitionAt: "2026-01-01T00:03:00.000Z",
    });
    const current = await store.getClaimView("split-status");

    expect(patched.spec).toEqual(created.spec);
    expect(patched.status.revision).toBe(2);
    expect(patched.status.observedGeneration).toBe(7);
    expect(patched.status.agentSessionId).toBe("session-1");
    expect(patched.status.currentContributionCid).toBe(
      "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(patched.status.conditions).toHaveLength(1);
    expect(patched.status.lastTransitionAt).toBe("2026-01-01T00:03:00.000Z");
    expect(current?.spec).toEqual(created.spec);
    expect(current?.status).toEqual(patched.status);
  });
});
