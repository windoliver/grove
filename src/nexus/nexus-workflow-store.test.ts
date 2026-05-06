import { describe, expect, test } from "bun:test";
import {
  createFallbackRoadmap,
  LoopStopStatus,
  type SessionAssessment,
  type WorkflowState,
} from "../core/loop-runner.js";
import { MockNexusClient } from "./mock-client.js";
import { NexusWorkflowStore } from "./nexus-workflow-store.js";
import { workflowPath } from "./vfs-paths.js";

const assessment: SessionAssessment = {
  goal: "Run review loop",
  roles: ["coder", "reviewer"],
  successCriteria: ["approved"],
  constraints: ["wait for reviewer"],
};

function makeState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    workflowId: "workflow-1",
    sessionId: "session-1",
    assessment,
    roadmap: createFallbackRoadmap(assessment),
    status: "running",
    currentIteration: 0,
    iterations: [],
    noImprovementRounds: 0,
    startedAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("NexusWorkflowStore", () => {
  test("saves and reads workflow state from the workflows VFS brick", async () => {
    const client = new MockNexusClient();
    const store = new NexusWorkflowStore({ client, zoneId: "zone/a" });
    const state = makeState({ workflowId: "wf/with/slash", bestScore: 0.42 });

    await store.saveWorkflowState(state);

    const loaded = await store.getWorkflowState("wf/with/slash");
    expect(loaded?.workflowId).toBe("wf/with/slash");
    expect(loaded?.bestScore).toBe(0.42);
    expect(await client.exists(workflowPath("zone/a", "wf/with/slash"))).toBe(true);
  });

  test("overwrites state as the loop advances", async () => {
    const client = new MockNexusClient();
    const store = new NexusWorkflowStore({ client, zoneId: "zone-a" });

    await store.saveWorkflowState(makeState({ currentIteration: 1 }));
    await store.saveWorkflowState(
      makeState({
        status: LoopStopStatus.Achieved,
        currentIteration: 2,
        completedAt: "2026-05-05T00:01:00.000Z",
      }),
    );

    const loaded = await store.getWorkflowState("workflow-1");
    expect(loaded?.status).toBe(LoopStopStatus.Achieved);
    expect(loaded?.currentIteration).toBe(2);
  });

  test("lists workflow states sorted by most recently updated", async () => {
    const client = new MockNexusClient();
    const store = new NexusWorkflowStore({ client, zoneId: "zone-a" });

    await store.saveWorkflowState(
      makeState({ workflowId: "older", updatedAt: "2026-05-05T00:00:00.000Z" }),
    );
    await store.saveWorkflowState(
      makeState({ workflowId: "newer", updatedAt: "2026-05-05T00:02:00.000Z" }),
    );

    const states = await store.listWorkflowStates();
    expect(states.map((state) => state.workflowId)).toEqual(["newer", "older"]);
  });

  test("returns undefined for missing workflow state", async () => {
    const store = new NexusWorkflowStore({ client: new MockNexusClient(), zoneId: "zone-a" });

    expect(await store.getWorkflowState("missing")).toBeUndefined();
  });
});
