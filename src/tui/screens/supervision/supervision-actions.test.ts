import { describe, expect, test } from "bun:test";
import type { AgentHealth } from "./agent-health.js";
import {
  actionEnabled,
  SUPERVISION_ACTIONS,
  type SupervisionAction,
} from "./supervision-actions.js";

const RUNNING: AgentHealth = { kind: "running" };
const APPROVAL: AgentHealth = { kind: "approval", cmd: "rm -rf /" };
const BLOCKED: AgentHealth = { kind: "blocked", on: "coordinator", sinceMs: 120_000 };
const EXPIRED: AgentHealth = { kind: "expired" };

describe("actionEnabled", () => {
  test("approve / deny / always require approval health", () => {
    expect(actionEnabled("approve", APPROVAL)).toBe(true);
    expect(actionEnabled("approve", RUNNING)).toBe(false);
    expect(actionEnabled("deny", APPROVAL)).toBe(true);
    expect(actionEnabled("deny", BLOCKED)).toBe(false);
    expect(actionEnabled("always", APPROVAL)).toBe(true);
  });

  test("reroute requires blocked health", () => {
    expect(actionEnabled("reroute", BLOCKED)).toBe(true);
    expect(actionEnabled("reroute", RUNNING)).toBe(false);
  });

  test("kill enabled for everything except expired", () => {
    expect(actionEnabled("kill", RUNNING)).toBe(true);
    expect(actionEnabled("kill", APPROVAL)).toBe(true);
    expect(actionEnabled("kill", BLOCKED)).toBe(true);
    expect(actionEnabled("kill", EXPIRED)).toBe(false);
  });

  test("tail / dag / message always enabled", () => {
    for (const action of ["tail", "dag", "message"] as SupervisionAction[]) {
      for (const h of [RUNNING, APPROVAL, BLOCKED, EXPIRED]) {
        expect(actionEnabled(action, h)).toBe(true);
      }
    }
  });

  test("SUPERVISION_ACTIONS lists each action exactly once", () => {
    const set = new Set(SUPERVISION_ACTIONS);
    expect(set.size).toBe(SUPERVISION_ACTIONS.length);
    expect(SUPERVISION_ACTIONS).toHaveLength(8);
  });
});
