import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../../provider.js";
import {
  resolveDefaultPreset,
  resolveInitialRoute,
  type WelcomeMode,
  type WelcomeRoute,
} from "./router.js";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    goal: "goal",
    status: "active",
    createdAt: new Date().toISOString(),
    contributionCount: 0,
    ...over,
  } as SessionRecord;
}

describe("resolveInitialRoute", () => {
  const info = { name: "demo", preset: "review-loop" };

  test("no grove → first-run mode step", () => {
    const r = resolveInitialRoute({ groveExists: false, sessions: [] });
    expect(r).toEqual({ kind: "first-run", step: "mode" });
  });

  test("grove exists, zero sessions → fast-path", () => {
    const r = resolveInitialRoute({ groveExists: true, sessions: [], groveInfo: info });
    expect(r).toEqual({ kind: "fast-path" });
  });

  test("grove exists, active sessions → fast-path", () => {
    const r = resolveInitialRoute({
      groveExists: true,
      sessions: [session(), session({ id: "s2", status: "completed" })],
      groveInfo: info,
    });
    expect(r).toEqual({ kind: "fast-path" });
  });

  test("grove exists with archived-only sessions → fast-path", () => {
    const r = resolveInitialRoute({
      groveExists: true,
      sessions: [session({ status: "archived" })],
      groveInfo: info,
    });
    expect(r).toEqual({ kind: "fast-path" });
  });

  test("grove exists but grove.json missing → first-run (defensive)", () => {
    const r = resolveInitialRoute({ groveExists: true, sessions: [] });
    expect(r).toEqual({ kind: "first-run", step: "mode" });
  });
});

describe("resolveDefaultPreset", () => {
  const presets = [
    { name: "coder", description: "" },
    { name: "reviewer-pair", description: "" },
    { name: "team-pair", description: "" },
    { name: "team-swarm", description: "" },
  ];

  test("local mode → first preset", () => {
    expect(resolveDefaultPreset("local", presets)).toBe("coder");
  });

  test("connected mode → first team-* preset", () => {
    expect(resolveDefaultPreset("connected", presets)).toBe("team-pair");
  });

  test("connected mode with no team preset → first preset fallback", () => {
    expect(
      resolveDefaultPreset("connected", [
        { name: "coder", description: "" },
        { name: "reviewer-pair", description: "" },
      ]),
    ).toBe("coder");
  });

  test("empty preset list returns undefined", () => {
    expect(resolveDefaultPreset("local", [])).toBeUndefined();
    expect(resolveDefaultPreset("connected", [])).toBeUndefined();
  });
});
