import { describe, expect, test } from "bun:test";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "../../core/timeline.js";
import { createTestApp, TEST_AUTH_HEADERS } from "../test-helpers.js";

describe("claim routes timeline projection", () => {
  test("direct claim create, heartbeat, and complete append timeline events", async () => {
    const { app, timelineStore } = createTestApp();
    if (timelineStore === undefined) throw new Error("Expected timeline store");
    await timelineStore.putWorkBlock(makeWorkBlock("wb_route_claim", "session-route"));

    const body = {
      claimId: "claim-route-timeline",
      targetRef: "task-route",
      agent: { agentId: "agent-route" },
      intentSummary: "route timeline",
      context: { session_id: "session-route", work_block_id: "wb_route_claim" },
    };
    const create = await app.request("/api/claims", {
      method: "POST",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const heartbeat = await app.request("/api/claims/claim-route-timeline", {
      method: "PATCH",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "heartbeat" }),
    });
    const complete = await app.request("/api/claims/claim-route-timeline", {
      method: "PATCH",
      headers: { ...TEST_AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete" }),
    });

    expect(create.status).toBe(201);
    expect(heartbeat.status).toBe(200);
    expect(complete.status).toBe(200);
    const events = await timelineStore.listTimelineEvents({ sessionId: "session-route" });
    expect(events.map((event) => event.type)).toContain(TimelineEventType.ClaimCreated);
    expect(events.map((event) => event.type)).toContain(TimelineEventType.ClaimLeaseRefreshed);
    expect(events.map((event) => event.type)).toContain(TimelineEventType.ClaimCompleted);
    expect(events.map((event) => event.type)).toContain(TimelineEventType.WorkBlockCompleted);
    const block = await timelineStore.getWorkBlock("wb_route_claim");
    expect(block?.status).toBe(WorkBlockStatus.Completed);
  });
});

function makeWorkBlock(workBlockId: string, sessionId: string) {
  return {
    workBlockId,
    sessionId,
    goal: "Complete routed claim",
    actor: { agentId: "agent-route" },
    origin: WorkBlockOrigin.Agent,
    status: WorkBlockStatus.Running,
    startedAt: "2026-05-13T10:00:00.000Z",
    updatedAt: "2026-05-13T10:00:00.000Z",
    inputRefs: [],
    outputRefs: [],
    evidenceRefs: [],
    approvalRefs: [],
    contributionCids: [],
    artifactHashes: [],
    claimIds: [],
    revision: 1,
    createdAt: "2026-05-13T10:00:00.000Z",
  };
}
