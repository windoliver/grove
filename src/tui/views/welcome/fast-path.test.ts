import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../../provider.js";
import { computeVisibleSessions } from "./fast-path.js";

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

describe("computeVisibleSessions", () => {
  test("empty sessions returns empty array", () => {
    expect(computeVisibleSessions([], false, "")).toEqual([]);
    expect(computeVisibleSessions([], true, "needle")).toEqual([]);
  });

  test("archiveVisible=false hides archived sessions", () => {
    const active = session({ id: "s1", status: "active" });
    const archived = session({ id: "s2", status: "archived" });
    expect(computeVisibleSessions([active, archived], false, "")).toEqual([active]);
  });

  test("archiveVisible=true includes archived sessions", () => {
    const active = session({ id: "s1", status: "active" });
    const archived = session({ id: "s2", status: "archived" });
    expect(computeVisibleSessions([active, archived], true, "")).toEqual([active, archived]);
  });

  test("archiveVisible=false with only archived sessions returns empty", () => {
    const a = session({ id: "s1", status: "archived" });
    const b = session({ id: "s2", status: "archived" });
    expect(computeVisibleSessions([a, b], false, "")).toEqual([]);
  });

  test("archiveVisible=true with only archived returns full list", () => {
    const a = session({ id: "s1", status: "archived" });
    const b = session({ id: "s2", status: "archived" });
    expect(computeVisibleSessions([a, b], true, "")).toEqual([a, b]);
  });

  test("filter text matches goal substring case-insensitively", () => {
    const s1 = session({ id: "s1", goal: "Refactor auth" });
    const s2 = session({ id: "s2", goal: "Fix login" });
    const s3 = session({ id: "s3", goal: "Audit perms" });
    expect(computeVisibleSessions([s1, s2, s3], false, "AUTH")).toEqual([s1]);
    expect(computeVisibleSessions([s1, s2, s3], false, "f")).toEqual([s1, s2]);
  });

  test("filter that matches nothing returns empty", () => {
    const s1 = session({ id: "s1", goal: "alpha" });
    expect(computeVisibleSessions([s1], false, "zzz")).toEqual([]);
  });

  test("filter applies after archive toggle — archived excluded when toggle off", () => {
    const active = session({ id: "s1", status: "active", goal: "alpha run" });
    const archived = session({ id: "s2", status: "archived", goal: "alpha old" });
    expect(computeVisibleSessions([active, archived], false, "alpha")).toEqual([active]);
    expect(computeVisibleSessions([active, archived], true, "alpha")).toEqual([active, archived]);
  });

  test("session with missing goal is tolerated (treated as empty string)", () => {
    const s1 = session({ id: "s1", goal: undefined as unknown as string });
    expect(computeVisibleSessions([s1], false, "")).toEqual([s1]);
    expect(computeVisibleSessions([s1], false, "x")).toEqual([]);
  });
});
