import { describe, expect, test } from "bun:test";

import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "./timeline.js";
import {
  parseSessionTimeline,
  parseTimelineEvent,
  parseTimelineEvents,
  parseWorkBlock,
  parseWorkBlocks,
} from "./timeline-schemas.js";

const actor = {
  agentId: "agent-1",
  agentName: "Timeline Agent",
  provider: "openai",
  model: "gpt-5",
};

const minimalWorkBlock = {
  workBlockId: "wb_00000000-0000-4000-8000-000000000001",
  goal: "Implement timeline contracts",
  actor,
  origin: WorkBlockOrigin.Manual,
  status: WorkBlockStatus.Running,
  updatedAt: "2026-05-13T10:00:00.000Z",
  createdAt: "2026-05-13T09:00:00.000Z",
  revision: 1,
  inputRefs: [],
  outputRefs: [],
  evidenceRefs: [],
  approvalRefs: [],
  contributionCids: [],
  artifactHashes: [],
  claimIds: [],
};

const minimalTimelineEvent = {
  eventId: "te_00000000-0000-4000-8000-000000000002",
  resourceVersion: "1",
  sessionId: "session-1",
  type: TimelineEventType.ContributionCreated,
  occurredAt: "2026-05-13T10:01:00.000Z",
  recordedAt: "2026-05-13T10:01:01.000Z",
  actor,
  workBlockId: "wb_00000000-0000-4000-8000-000000000001",
  targetRefs: [{ kind: "contribution", id: "blake3:abc", label: "Result", href: "/c/abc" }],
  payload: { cid: "blake3:abc", nested: { accepted: true } },
};

describe("timeline schemas", () => {
  test("parseWorkBlock accepts a minimal WorkBlock", () => {
    expect(parseWorkBlock(minimalWorkBlock)).toEqual(minimalWorkBlock);
  });

  test("parseWorkBlock rejects an invalid status", () => {
    expect(() => parseWorkBlock({ ...minimalWorkBlock, status: "done" })).toThrow();
  });

  test("parseWorkBlock rejects negative costSummary.costUsd", () => {
    expect(() =>
      parseWorkBlock({ ...minimalWorkBlock, costSummary: { costUsd: -0.01 } }),
    ).toThrow();
  });

  test("parseWorkBlock rejects non-ISO timestamps", () => {
    expect(() => parseWorkBlock({ ...minimalWorkBlock, updatedAt: "1" })).toThrow();
    expect(() => parseWorkBlock({ ...minimalWorkBlock, createdAt: "2026-05-13" })).toThrow();
  });

  test("parseWorkBlock rejects empty required identity fields", () => {
    expect(() => parseWorkBlock({ ...minimalWorkBlock, workBlockId: "" })).toThrow();
    expect(() => parseWorkBlock({ ...minimalWorkBlock, goal: "" })).toThrow();
  });

  test("parseTimelineEvent accepts a valid event", () => {
    expect(parseTimelineEvent(minimalTimelineEvent)).toEqual(minimalTimelineEvent);
  });

  test("parseTimelineEvent rejects invalid event identity and versions", () => {
    expect(() => parseTimelineEvent({ ...minimalTimelineEvent, eventId: "" })).toThrow();
    expect(() =>
      parseTimelineEvent({ ...minimalTimelineEvent, resourceVersion: "rv-1" }),
    ).toThrow();
    expect(() => parseTimelineEvent({ ...minimalTimelineEvent, type: "unknown.event" })).toThrow();
  });

  test("parseTimelineEvent rejects non-ISO timestamps", () => {
    expect(() =>
      parseTimelineEvent({ ...minimalTimelineEvent, recordedAt: "2026-05-13" }),
    ).toThrow();
  });

  test("schemas reject unknown fields", () => {
    expect(() => parseWorkBlock({ ...minimalWorkBlock, extra: true })).toThrow();
    expect(() => parseTimelineEvent({ ...minimalTimelineEvent, extra: true })).toThrow();
  });

  test("parseSessionTimeline accepts a session timeline", () => {
    const timeline = {
      sessionId: "session-1",
      events: [minimalTimelineEvent],
      timelineResourceVersion: "2",
    };

    expect(parseSessionTimeline(timeline)).toEqual(timeline);
  });

  test("array parsers accept empty arrays", () => {
    expect(parseWorkBlocks([])).toEqual([]);
    expect(parseTimelineEvents([])).toEqual([]);
  });
});
