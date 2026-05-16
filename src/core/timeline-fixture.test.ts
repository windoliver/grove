import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryTimelineStore } from "./testing.js";
import { TimelineEventType, WorkBlockStatus } from "./timeline.js";
import { parseSessionTimeline } from "./timeline-schemas.js";

const fixturePath = join(
  import.meta.dir,
  "../../tests/fixtures/timeline/incident-investigation.json",
);

describe("timeline fixtures", () => {
  test("incident investigation fixture is non-coding, schema-valid, and store-replayable", async () => {
    const timeline = parseSessionTimeline(JSON.parse(readFileSync(fixturePath, "utf8")));
    const store = new InMemoryTimelineStore();

    for (const block of timeline.workBlocks ?? []) {
      await store.putWorkBlock(block);
    }
    for (const event of timeline.events) {
      const { resourceVersion: _resourceVersion, ...input } = event;
      await store.appendTimelineEvent(input);
    }

    const replayedEvents = await store.listTimelineEvents({ sessionId: timeline.sessionId });
    const replayedBlocks = await store.listWorkBlocks({ sessionId: timeline.sessionId });

    expect(await store.currentTimelineResourceVersion(timeline.sessionId)).toBe(
      timeline.timelineResourceVersion,
    );
    expect(replayedEvents.map((event) => event.type)).toEqual(
      timeline.events.map((event) => event.type),
    );
    expect(replayedBlocks).toHaveLength(timeline.workBlocks?.length ?? 0);
    expect(replayedEvents.some((event) => event.type === TimelineEventType.ApprovalRequested)).toBe(
      true,
    );
    expect(replayedEvents.some((event) => event.type === TimelineEventType.ApprovalDecided)).toBe(
      true,
    );
    expect(replayedEvents.some((event) => event.type === TimelineEventType.CostReported)).toBe(
      true,
    );
    expect(
      replayedEvents.some((event) => event.type === TimelineEventType.WorkBlockCompleted),
    ).toBe(true);
    expect(
      replayedBlocks.some((block) =>
        block.evidenceRefs.some((ref) => ref.kind === "dashboard" || ref.kind === "log_search"),
      ),
    ).toBe(true);
    expect(replayedBlocks.some((block) => block.status === WorkBlockStatus.Completed)).toBe(true);

    const serialized = JSON.stringify(timeline);
    expect(serialized).not.toContain("commitHash");
    expect(serialized).not.toContain("pullRequest");
    expect(serialized).not.toContain("programmingLanguage");
    expect(serialized).not.toContain("filePath");
    expect(serialized).not.toContain("testCommand");
  });
});
