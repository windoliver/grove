import { describe, expect, test } from "bun:test";
import type { AgentTaskView } from "../../agent-task.js";
import { AgentTaskPhase } from "../../agent-task.js";
import type { SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";
import { BudgetRemainingFilter, type BudgetLedger } from "./budget-remaining.js";

function makeCtx(task: AgentTaskView): SchedulerContext {
  return { task, profiles: [], store: { listAgentTaskEntities: async () => [] }, now: () => 0 };
}

function task(overrides: Partial<AgentTaskView["spec"]> = {}): AgentTaskView {
  return {
    spec: {
      id: "t",
      worktree: "/tmp/w",
      runtime: "claude",
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
      ...overrides,
    },
    status: {
      id: "t",
      phase: AgentTaskPhase.PendingBind,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

function profile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return { name: "p", platform: "claude-code", runtimeCommand: "claude", ...overrides };
}

describe("BudgetRemainingFilter", () => {
  test("admits when task budget fits within profile budget", async () => {
    const filter = new BudgetRemainingFilter();
    const verdict = await filter.filter(
      makeCtx(task({ budget: { maxCostUsd: 5 }, maxTurns: 10 })),
      profile({ budget: { maxCostUsd: 10, maxTurns: 50 } }),
    );
    expect(verdict).toEqual({ admit: true });
  });

  test("rejects when task maxCostUsd exceeds profile maxCostUsd", async () => {
    const filter = new BudgetRemainingFilter();
    const verdict = await filter.filter(
      makeCtx(task({ budget: { maxCostUsd: 20 } })),
      profile({ budget: { maxCostUsd: 10 } }),
    );
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) expect(verdict.reason).toBe("budget-exceeds-profile");
  });

  test("rejects when task maxTurns exceeds profile maxTurns", async () => {
    const filter = new BudgetRemainingFilter();
    const verdict = await filter.filter(
      makeCtx(task({ maxTurns: 100 })),
      profile({ budget: { maxTurns: 50 } }),
    );
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) expect(verdict.reason).toBe("turns-exceeds-profile");
  });

  test("admits when profile budget is undefined regardless of task budget", async () => {
    const filter = new BudgetRemainingFilter();
    const verdict = await filter.filter(
      makeCtx(task({ budget: { maxCostUsd: 999 } })),
      profile(),
    );
    expect(verdict).toEqual({ admit: true });
  });

  test("admits when task budget is undefined", async () => {
    const filter = new BudgetRemainingFilter();
    const verdict = await filter.filter(makeCtx(task()), profile({ budget: { maxCostUsd: 1 } }));
    expect(verdict).toEqual({ admit: true });
  });

  test("ledger that returns false rejects with ledger-exhausted reason", async () => {
    const ledger: BudgetLedger = { hasRemaining: async () => false };
    const filter = new BudgetRemainingFilter({ ledger });
    const verdict = await filter.filter(makeCtx(task()), profile());
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) expect(verdict.reason).toBe("ledger-exhausted");
  });

  test("default ledger is permissive", async () => {
    const filter = new BudgetRemainingFilter();
    const verdict = await filter.filter(makeCtx(task()), profile());
    expect(verdict).toEqual({ admit: true });
  });
});
