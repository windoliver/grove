/**
 * Tests for C2 (#302) row-narrowing in AgentListView.
 *
 * Closes the integration gap that unit tests in `aliases.test.ts` and the
 * acceptance test in `running-view.c2.test.tsx` don't reach: that the
 * `filterText` prop actually narrows the rendered row set in the agent list.
 *
 * The filter applies to a Record<string, string> shape (the `Table`-ready
 * row format produced by `buildAgentRows`). We exercise it directly with
 * representative rows so the behavior is asserted on the same surface that
 * the live view consumes.
 */

import { describe, expect, test } from "bun:test";
import { applyAgentFilter } from "./agent-list.js";

const sampleRows: readonly Record<string, string>[] = [
  {
    agentId: "coder-1",
    role: "coder",
    platform: "claude",
    status: "▶ running",
    cost: "$0.42 | 12K",
    target: "review/intake",
    session: "grove-coder-1",
  },
  {
    agentId: "reviewer-1",
    role: "reviewer",
    platform: "codex",
    status: "○ idle",
    cost: "-",
    target: "review/intake",
    session: "-",
  },
  {
    agentId: "perf-bot",
    role: "perf-bot",
    platform: "gemini",
    status: "✗ stalled",
    cost: "$1.20 | 88K",
    target: "bench/perf",
    session: "grove-perf-bot",
  },
];

describe("C2 agent-list filter", () => {
  test("empty / undefined filter returns all rows", () => {
    expect(applyAgentFilter(sampleRows, undefined).length).toBe(3);
    expect(applyAgentFilter(sampleRows, "").length).toBe(3);
    expect(applyAgentFilter(sampleRows, "   ").length).toBe(3);
  });

  test("filter narrows to matching role", () => {
    const r = applyAgentFilter(sampleRows, "coder");
    expect(r.length).toBe(1);
    expect(r[0]?.agentId).toBe("coder-1");
  });

  test("filter narrows to matching platform", () => {
    const r = applyAgentFilter(sampleRows, "codex");
    expect(r.length).toBe(1);
    expect(r[0]?.role).toBe("reviewer");
  });

  test("filter is case-insensitive", () => {
    expect(applyAgentFilter(sampleRows, "PERF").length).toBe(1);
    expect(applyAgentFilter(sampleRows, "Perf").length).toBe(1);
    expect(applyAgentFilter(sampleRows, "perf").length).toBe(1);
  });

  test("filter searches across all columns (status, target)", () => {
    expect(applyAgentFilter(sampleRows, "running")[0]?.role).toBe("coder");
    expect(applyAgentFilter(sampleRows, "stalled")[0]?.role).toBe("perf-bot");
    expect(applyAgentFilter(sampleRows, "intake").length).toBe(2);
  });

  test("substring matching, not exact", () => {
    // 'rev' matches reviewer-1's role/agentId and coder-1's review/intake target.
    // perf-bot has no 'rev' substring anywhere.
    expect(applyAgentFilter(sampleRows, "rev").length).toBe(2);
    expect(applyAgentFilter(sampleRows, "bench").length).toBe(1);
  });

  test("no matches returns empty", () => {
    expect(applyAgentFilter(sampleRows, "zzznomatch").length).toBe(0);
  });

  test("whitespace inside query is preserved (matches multi-word column)", () => {
    expect(applyAgentFilter(sampleRows, "○ idle").length).toBe(1);
  });

  test("identity check: empty filter returns the same array reference", () => {
    expect(applyAgentFilter(sampleRows, undefined)).toBe(sampleRows);
  });
});
