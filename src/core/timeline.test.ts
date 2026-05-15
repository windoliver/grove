import { describe, expect, test } from "bun:test";

import {
  buildTimelineEventId,
  buildWorkBlockId,
  mergeCostSummary,
  TimelineEventType,
  timelineScope,
  WorkBlockOrigin,
  WorkBlockStatus,
} from "./timeline.js";

describe("timeline contracts", () => {
  test("exports stable literal values", () => {
    expect(WorkBlockStatus.Running).toBe("running");
    expect(WorkBlockStatus.WaitingApproval).toBe("waiting_approval");
    expect(WorkBlockOrigin.Triggered).toBe("triggered");
    expect(TimelineEventType.ContributionCreated).toBe("contribution.created");
    expect(TimelineEventType.ApprovalDecided).toBe("approval.decided");
  });

  test("builds prefixed IDs from UUID providers", () => {
    expect(buildWorkBlockId(() => "00000000-0000-4000-8000-000000000001")).toBe(
      "wb_00000000-0000-4000-8000-000000000001",
    );
    expect(buildTimelineEventId(() => "00000000-0000-4000-8000-000000000002")).toBe(
      "te_00000000-0000-4000-8000-000000000002",
    );
  });

  test("builds global and session timeline scopes", () => {
    expect(timelineScope()).toBe("global");
    expect(timelineScope("session/alpha")).toBe("session/session%2Falpha");
    expect(timelineScope("session%alpha/beta")).toBe("session/session%25alpha%2Fbeta");
  });

  test("merges cost summaries additively while incoming model wins", () => {
    expect(
      mergeCostSummary(
        { inputTokens: 10, outputTokens: 20, costUsd: 0.1, model: "older" },
        { inputTokens: 5, outputTokens: 7, costUsd: 0.2, model: "newer" },
      ),
    ).toEqual({
      inputTokens: 15,
      outputTokens: 27,
      costUsd: 0.30000000000000004,
      model: "newer",
    });
  });
});
