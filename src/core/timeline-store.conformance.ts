/**
 * Conformance test suite for TimelineStore implementations.
 *
 * Any backend that implements TimelineStore can validate its behavior by
 * calling `runTimelineStoreConformance()` with a fresh-store harness.
 */

import { describe, expect, test } from "bun:test";
import type { WorkBlock } from "./timeline.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "./timeline.js";
import type { TimelineEventInput, TimelineStore } from "./timeline-store.js";

export interface TimelineStoreHarness {
  readonly name: string;
  readonly createStore: () => Promise<{
    readonly store: TimelineStore;
    readonly close: () => void;
  }>;
}

export function runTimelineStoreConformance(harness: TimelineStoreHarness): void {
  describe(`${harness.name} TimelineStore conformance`, () => {
    test("stores, patches, and lists work blocks", async () => {
      const { store, close } = await harness.createStore();
      try {
        const stored = await store.putWorkBlock(makeWorkBlock());
        expect(stored.workBlockId).toBe("wb-conformance-1");
        expect(stored.status).toBe(WorkBlockStatus.Pending);

        const patched = await store.patchWorkBlock("wb-conformance-1", {
          status: WorkBlockStatus.Running,
          startedAt: "2026-05-13T10:01:00.000Z",
        });
        expect(patched.status).toBe(WorkBlockStatus.Running);
        expect(patched.startedAt).toBe("2026-05-13T10:01:00.000Z");
        expect(patched.revision).toBe(2);

        const fetched = await store.getWorkBlock("wb-conformance-1");
        expect(fetched?.status).toBe(WorkBlockStatus.Running);

        const listed = await store.listWorkBlocks({
          sessionId: "session-conformance",
          status: WorkBlockStatus.Running,
        });
        expect(listed.map((block) => block.workBlockId)).toEqual(["wb-conformance-1"]);

        const entityListed = await store.listWorkBlockEntities({
          sessionId: "session-conformance",
          status: WorkBlockStatus.Running,
        });
        expect(entityListed[0]?.kind).toBe("WorkBlock");
        expect(entityListed.map((entity) => entity.id)).toContain("wb-conformance-1");
      } finally {
        store.close();
        close();
      }
    });

    test("appends timeline events with monotonic resource versions", async () => {
      const { store, close } = await harness.createStore();
      try {
        const first = await store.appendTimelineEvent(
          makeTimelineEventInput("te-conformance-1", TimelineEventType.WorkBlockCreated),
        );
        const second = await store.appendTimelineEvent(
          makeTimelineEventInput("te-conformance-2", TimelineEventType.WorkBlockStarted),
        );

        expect(first.resourceVersion).toBe("1");
        expect(second.resourceVersion).toBe("2");
        expect(second.recordedAt).toBeDefined();

        const listed = await store.listTimelineEvents({
          sessionId: "session-conformance",
          afterRv: first.resourceVersion,
        });
        expect(listed.map((event) => event.eventId)).toEqual(["te-conformance-2"]);

        const entityListed = await store.listTimelineEventEntities({
          sessionId: "session-conformance",
          afterRv: first.resourceVersion,
        });
        expect(entityListed[0]?.kind).toBe("TimelineEvent");
        expect(entityListed.map((entity) => entity.id)).toContain("te-conformance-2");

        const currentRv = await store.currentTimelineResourceVersion("session-conformance");
        expect(currentRv).toBe("2");
      } finally {
        store.close();
        close();
      }
    });
  });
}

function makeWorkBlock(overrides: Partial<WorkBlock> = {}): WorkBlock {
  return {
    workBlockId: "wb-conformance-1",
    sessionId: "session-conformance",
    goal: "Exercise TimelineStore conformance",
    actor: { agentId: "agent-conformance", role: "coder", platform: "codex" },
    origin: WorkBlockOrigin.Agent,
    status: WorkBlockStatus.Pending,
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
    ...overrides,
  };
}

function makeTimelineEventInput(eventId: string, type: TimelineEventType): TimelineEventInput {
  return {
    eventId,
    sessionId: "session-conformance",
    type,
    occurredAt: "2026-05-13T10:00:00.000Z",
    actor: { agentId: "agent-conformance", role: "coder", platform: "codex" },
    workBlockId: "wb-conformance-1",
    targetRefs: [{ kind: "WorkBlock", id: "wb-conformance-1" }],
    payload: {},
  };
}
