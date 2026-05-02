/**
 * Tests for the dashboard view's PR3 (#389) cross-cut projection.
 *
 * The view itself reads `useDerived` over `["Contribution"]` to project a
 * recent-contributions snapshot. Active claims stay on the polled
 * (lease-aware) path because lease expiry is wall-clock-driven and emits
 * no watch event. The pure `crossCutEquals` comparator is the
 * memoization fence — it must collapse recomputes that produce the same
 * visible snapshot, and detect any change to count or contribution
 * identity / visible fields.
 */

import { describe, expect, test } from "bun:test";
import type { Contribution } from "../../core/models.js";
import { crossCutEquals } from "./dashboard.js";

const baseContribution: Contribution = {
  cid: "blake3:aaa",
  manifestVersion: 0,
  kind: "work",
  mode: "evaluation",
  summary: "s",
  artifacts: {},
  relations: [],
  tags: [],
  agent: { agentId: "a1" },
  createdAt: "2026-01-01T00:00:00Z",
};

describe("crossCutEquals (PR3 #389 dashboard projection)", () => {
  test("identical references → true", () => {
    const cross = {
      recentContributions: [baseContribution],
      contributionCount: 1,
    };
    expect(crossCutEquals(cross, cross)).toBe(true);
  });

  test("same shape, same array entries (by reference) → true", () => {
    const a = {
      recentContributions: [baseContribution],
      contributionCount: 1,
    };
    const b = {
      recentContributions: [baseContribution],
      contributionCount: 1,
    };
    expect(crossCutEquals(a, b)).toBe(true);
  });

  test("contributionCount changes → false", () => {
    const a = {
      recentContributions: [baseContribution],
      contributionCount: 1,
    };
    const b = { ...a, contributionCount: 2 };
    expect(crossCutEquals(a, b)).toBe(false);
  });

  test("contribution identity changes → false (counts the same)", () => {
    const contrib2: Contribution = { ...baseContribution, cid: "blake3:bbb" };
    const a = {
      recentContributions: [baseContribution],
      contributionCount: 1,
    };
    const b = { ...a, recentContributions: [contrib2] };
    expect(crossCutEquals(a, b)).toBe(false);
  });

  test("distinct object instances with identical projected fields → true (structural compare)", () => {
    // Regression for codex round-1: each useDerived recompute calls
    // entityToContribution producing fresh objects. Reference compare would
    // always fail; structural compare must collapse no-ops.
    const cloneA: Contribution = { ...baseContribution };
    const cloneB: Contribution = { ...baseContribution };
    const a = {
      recentContributions: [cloneA],
      contributionCount: 1,
    };
    const b = {
      recentContributions: [cloneB],
      contributionCount: 1,
    };
    expect(cloneA === cloneB).toBe(false);
    expect(crossCutEquals(a, b)).toBe(true);
  });

  test("contribution kind change → false (visible column)", () => {
    // Regression for codex round-3: agent/kind backfills on a stable cid
    // must invalidate the memoization fence.
    const updated: Contribution = { ...baseContribution, kind: "review" };
    const a = {
      recentContributions: [baseContribution],
      contributionCount: 1,
    };
    const b = { ...a, recentContributions: [updated] };
    expect(crossCutEquals(a, b)).toBe(false);
  });

  test("contribution agent display change → false (visible column)", () => {
    const updated: Contribution = {
      ...baseContribution,
      agent: { agentId: "a1", agentName: "agent-one" },
    };
    const a = {
      recentContributions: [baseContribution],
      contributionCount: 1,
    };
    const b = { ...a, recentContributions: [updated] };
    expect(crossCutEquals(a, b)).toBe(false);
  });

  test("contribution summary change → false", () => {
    const updated: Contribution = { ...baseContribution, summary: "different" };
    const a = {
      recentContributions: [baseContribution],
      contributionCount: 1,
    };
    const b = { ...a, recentContributions: [updated] };
    expect(crossCutEquals(a, b)).toBe(false);
  });

  test("array length differs → false", () => {
    const a = {
      recentContributions: [baseContribution],
      contributionCount: 1,
    };
    const b = {
      recentContributions: [baseContribution, { ...baseContribution, cid: "blake3:bbb" }],
      contributionCount: 2,
    };
    expect(crossCutEquals(a, b)).toBe(false);
  });
});
