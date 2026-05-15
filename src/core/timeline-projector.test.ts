import { describe, expect, test } from "bun:test";
import type { Contribution } from "./models.js";
import { ContributionKind, ContributionMode, RelationType } from "./models.js";
import { buildPlanContext } from "./operations/context-schemas.js";
import { TimelineEventType } from "./timeline.js";
import { timelineEventsForContribution } from "./timeline-projector.js";

const baseContribution: Contribution = {
  cid: "cid-1",
  manifestVersion: 1,
  kind: ContributionKind.Work,
  mode: ContributionMode.Exploration,
  summary: "Investigated incident",
  artifacts: { report: "blake3:abc" },
  relations: [],
  tags: ["incident"],
  agent: { agentId: "agent-1" },
  createdAt: "2026-05-13T10:00:00.000Z",
};

describe("timeline projector", () => {
  test("projects contribution and artifact events", () => {
    const events = timelineEventsForContribution(baseContribution);

    expect(events.map((event) => event.eventId)).toContain("te:contribution:cid-1:created");
    expect(events.map((event) => event.type)).toContain(TimelineEventType.ContributionCreated);
    expect(events.map((event) => event.type)).toContain(TimelineEventType.ArtifactLinked);
  });

  test("projects ask-user approval request and answer", () => {
    const question: Contribution = {
      ...baseContribution,
      cid: "cid-question",
      kind: ContributionKind.AskUser,
      context: { question_text: "Approve mitigation?" },
    };
    const answer: Contribution = {
      ...baseContribution,
      cid: "cid-answer",
      kind: ContributionKind.Response,
      relations: [{ targetCid: "cid-question", relationType: RelationType.RespondsTo }],
      context: { answer_text: "Approved" },
    };

    expect(timelineEventsForContribution(question).map((event) => event.type)).toContain(
      TimelineEventType.ApprovalRequested,
    );
    expect(timelineEventsForContribution(answer).map((event) => event.type)).toContain(
      TimelineEventType.ApprovalDecided,
    );
  });

  test("projects usage reports", () => {
    const usage: Contribution = {
      ...baseContribution,
      cid: "cid-usage",
      kind: ContributionKind.Discussion,
      context: {
        ephemeral: true,
        session_id: "session-1",
        work_block_id: "wb_1",
        usage_report: { input_tokens: 10, output_tokens: 5, cost_usd: 0.2 },
      },
    };

    const events = timelineEventsForContribution(usage);
    expect(
      events.some(
        (event) => event.type === TimelineEventType.CostReported && event.workBlockId === "wb_1",
      ),
    ).toBe(true);
  });

  test("projects plan task creations and changed task status only", () => {
    const previousPlan: Contribution = {
      ...baseContribution,
      cid: "cid-plan-v1",
      kind: ContributionKind.Plan,
      artifacts: {},
      context: buildPlanContext({
        title: "Incident plan",
        tasks: [
          { id: "triage", title: "Triage", status: "todo" },
          { id: "notify", title: "Notify", status: "todo" },
        ],
      }),
    };
    const currentPlan: Contribution = {
      ...baseContribution,
      cid: "cid-plan-v2",
      kind: ContributionKind.Plan,
      artifacts: {},
      relations: [{ targetCid: "cid-plan-v1", relationType: RelationType.DerivesFrom }],
      context: buildPlanContext({
        title: "Incident plan",
        tasks: [
          { id: "triage", title: "Triage", status: "done" },
          { id: "notify", title: "Notify", status: "todo" },
          { id: "brief", title: "Brief support", status: "in_progress" },
        ],
      }),
    };

    const events = timelineEventsForContribution(currentPlan, { previousPlan });
    expect(events.map((event) => event.eventId)).toContain("te:plan:cid-plan-v2:task:triage:done");
    expect(events.map((event) => event.eventId)).toContain(
      "te:plan:cid-plan-v2:task:brief:in_progress",
    );
    expect(events.map((event) => event.eventId)).not.toContain(
      "te:plan:cid-plan-v2:task:notify:todo",
    );
    expect(events.map((event) => event.type)).toContain(TimelineEventType.PlanTaskStatusChanged);
    expect(events.map((event) => event.type)).toContain(TimelineEventType.PlanTaskCreated);
  });
});
