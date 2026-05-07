import { describe, expect, test } from "bun:test";
import {
  createFallbackRoadmap,
  createInterruptController,
  findFirstBalancedBraces,
  GroveLoopRunner,
  LoopStopStatus,
  parseIterationRoadmap,
  type WorkflowState,
  type WorkflowStateStore,
} from "./loop-runner.js";

const assessment = {
  goal: "Fix the review loop",
  roles: ["coder", "reviewer"],
  successCriteria: ["reviewer approves", "tests pass"],
  constraints: ["do not stop before review"],
};

class MemoryWorkflowStore implements WorkflowStateStore {
  readonly states: WorkflowState[] = [];

  async saveWorkflowState(state: WorkflowState): Promise<void> {
    this.states.push(structuredClone(state));
  }
}

describe("findFirstBalancedBraces", () => {
  test("extracts the first balanced JSON object from prose", () => {
    const text = 'before {"a":{"b":1},"text":"brace } in string"} after {"ignored":true}';

    expect(findFirstBalancedBraces(text)).toBe('{"a":{"b":1},"text":"brace } in string"}');
  });

  test("returns undefined when no balanced object exists", () => {
    expect(findFirstBalancedBraces('before {"a":1')).toBeUndefined();
  });
});

describe("parseIterationRoadmap", () => {
  test("parses planner JSON embedded in prose", () => {
    const roadmap = parseIterationRoadmap(
      `
      Planner notes:
      {
        "stages": [
          {
            "id": "code",
            "title": "Implement",
            "role": "coder",
            "prompt": "write the fix",
            "successCriteria": ["tests pass"]
          }
        ]
      }
      `,
      assessment,
    );

    expect(roadmap.source).toBe("planner");
    expect(roadmap.stages).toHaveLength(1);
    expect(roadmap.stages[0]?.id).toBe("code");
  });

  test("returns a default roadmap when planner JSON is invalid", () => {
    const roadmap = parseIterationRoadmap("not json", assessment);

    expect(roadmap.source).toBe("fallback");
    expect(roadmap.stages.map((stage) => stage.role)).toEqual(["coder", "reviewer"]);
  });
});

describe("createFallbackRoadmap", () => {
  test("creates one stage per role with the goal and success criteria", () => {
    const roadmap = createFallbackRoadmap(assessment);

    expect(roadmap.source).toBe("fallback");
    expect(roadmap.stages).toHaveLength(2);
    expect(roadmap.stages[0]?.prompt).toContain("Fix the review loop");
    expect(roadmap.stages[0]?.successCriteria).toEqual(assessment.successCriteria);
  });
});

describe("GroveLoopRunner", () => {
  test("stops with achieved when an iteration reports success", async () => {
    const store = new MemoryWorkflowStore();
    const runner = new GroveLoopRunner({
      workflowId: "wf-achieved",
      sessionId: "session-1",
      assessment,
      roadmap: createFallbackRoadmap(assessment),
      workflowStore: store,
      executeIteration: async () => ({
        score: 0.5,
        achieved: true,
        summary: "review approved",
      }),
    });

    const result = await runner.run();

    expect(result.status).toBe(LoopStopStatus.Achieved);
    expect(result.iterations).toHaveLength(1);
    expect(store.states.at(-1)?.status).toBe(LoopStopStatus.Achieved);
  });

  test("stops with plateau after configured no-improvement rounds", async () => {
    const scores = [1.0, 1.004, 1.006];
    const runner = new GroveLoopRunner({
      workflowId: "wf-plateau",
      sessionId: "session-1",
      assessment,
      roadmap: createFallbackRoadmap(assessment),
      maxNoImprovementRounds: 2,
      improvementThreshold: 0.01,
      executeIteration: async () => ({
        score: scores.shift() ?? 1.006,
        summary: "small change",
      }),
    });

    const result = await runner.run();

    expect(result.status).toBe(LoopStopStatus.Plateau);
    expect(result.iterations).toHaveLength(3);
    expect(result.noImprovementRounds).toBe(2);
  });

  test("stops with max_iterations at the hard cap", async () => {
    const runner = new GroveLoopRunner({
      workflowId: "wf-max",
      sessionId: "session-1",
      assessment,
      roadmap: createFallbackRoadmap(assessment),
      maxIterations: 2,
      maxNoImprovementRounds: 10,
      executeIteration: async ({ iteration }) => ({
        score: iteration,
        summary: `round ${iteration}`,
      }),
    });

    const result = await runner.run();

    expect(result.status).toBe(LoopStopStatus.MaxIterations);
    expect(result.iterations.map((iteration) => iteration.iteration)).toEqual([1, 2]);
  });

  test("stops with interrupted before starting the next iteration", async () => {
    const interrupt = createInterruptController();
    let calls = 0;
    const runner = new GroveLoopRunner({
      workflowId: "wf-interrupted",
      sessionId: "session-1",
      assessment,
      roadmap: createFallbackRoadmap(assessment),
      interrupt,
      maxIterations: 5,
      executeIteration: async () => {
        calls += 1;
        interrupt.requestInterrupt("operator stop");
        return { score: calls, summary: "requested stop" };
      },
    });

    const result = await runner.run();

    expect(result.status).toBe(LoopStopStatus.Interrupted);
    expect(result.reason).toBe("operator stop");
    expect(calls).toBe(1);
  });

  test("uses explicit terminal stop status from an iteration result", async () => {
    const runner = new GroveLoopRunner({
      workflowId: "wf-terminal",
      sessionId: "session-1",
      assessment,
      roadmap: createFallbackRoadmap(assessment),
      executeIteration: async () => ({
        stopStatus: LoopStopStatus.MaxIterations,
        summary: "session timed out",
      }),
    });

    const result = await runner.run();

    expect(result.status).toBe(LoopStopStatus.MaxIterations);
    expect(result.reason).toBe("session timed out");
    expect(result.iterations).toHaveLength(1);
  });

  test("stops with error when iteration throws and persists the final state", async () => {
    const store = new MemoryWorkflowStore();
    const runner = new GroveLoopRunner({
      workflowId: "wf-error",
      sessionId: "session-1",
      assessment,
      roadmap: createFallbackRoadmap(assessment),
      workflowStore: store,
      executeIteration: async () => {
        throw new Error("provider failed");
      },
    });

    const result = await runner.run();

    expect(result.status).toBe(LoopStopStatus.Error);
    expect(result.reason).toContain("provider failed");
    expect(store.states.at(-1)?.status).toBe(LoopStopStatus.Error);
  });
});
