import { describe, expect, test } from "bun:test";
import type { Contribution } from "../../core/models.js";
import type { TuiDataProvider, TuiSessionProvider } from "../provider.js";
import {
  fetchRunningContributions,
  updateRunningContributionSeenState,
} from "./running-contributions.js";

function contribution(cid: string, summary: string): Contribution {
  return {
    cid,
    manifestVersion: 1,
    kind: "work",
    mode: "evaluation",
    summary,
    tags: [],
    artifacts: {},
    relations: [],
    agent: { agentId: "agent-1" },
    createdAt: new Date().toISOString(),
  };
}

function baseCapabilities(sessions: boolean) {
  return {
    outcomes: false,
    artifacts: false,
    vfs: false,
    messaging: false,
    costTracking: false,
    askUser: false,
    github: false,
    bounties: false,
    gossip: false,
    goals: false,
    sessions,
    handoffs: false,
    prompts: false,
    skills: false,
  };
}

describe("fetchRunningContributions", () => {
  test("uses full session contribution history when a session id is present", async () => {
    const sessionHistory = [contribution("blake3:session", "session")];
    const liveList = [contribution("blake3:live", "live")];
    const calls: string[] = [];
    const provider = {
      capabilities: baseCapabilities(true),
      getContributions: async () => {
        calls.push("getContributions");
        return liveList;
      },
      getSessionContributions: async (sessionId: string) => {
        calls.push(`getSessionContributions:${sessionId}`);
        return sessionHistory;
      },
    } as unknown as TuiDataProvider & TuiSessionProvider;

    const result = await fetchRunningContributions(provider, "session-1");

    expect(result).toEqual(sessionHistory);
    expect(calls).toEqual(["getSessionContributions:session-1"]);
  });

  test("uses normal contribution list when no session id is present", async () => {
    const liveList = [contribution("blake3:live", "live")];
    const calls: string[] = [];
    const provider = {
      capabilities: baseCapabilities(true),
      getContributions: async () => {
        calls.push("getContributions");
        return liveList;
      },
      getSessionContributions: async () => {
        calls.push("getSessionContributions");
        return [];
      },
    } as unknown as TuiDataProvider & TuiSessionProvider;

    const result = await fetchRunningContributions(provider, undefined);

    expect(result).toEqual(liveList);
    expect(calls).toEqual(["getContributions"]);
  });

  test("uses normal contribution list when session id is present but sessions are unsupported", async () => {
    const liveList = [contribution("blake3:live", "live")];
    const calls: string[] = [];
    const provider = {
      capabilities: baseCapabilities(false),
      getContributions: async () => {
        calls.push("getContributions");
        return liveList;
      },
    } as unknown as TuiDataProvider;

    const result = await fetchRunningContributions(provider, "session-1");

    expect(result).toEqual(liveList);
    expect(calls).toEqual(["getContributions"]);
  });

  test("uses normal contribution list when session capability is set but method is absent", async () => {
    const liveList = [contribution("blake3:live", "live")];
    const calls: string[] = [];
    const provider = {
      capabilities: baseCapabilities(true),
      getContributions: async () => {
        calls.push("getContributions");
        return liveList;
      },
    } as unknown as TuiDataProvider;

    const result = await fetchRunningContributions(provider, "session-1");

    expect(result).toEqual(liveList);
    expect(calls).toEqual(["getContributions"]);
  });
});

describe("updateRunningContributionSeenState", () => {
  test("seeds the first resumed feed without marking historical CIDs as new", () => {
    const historical = [contribution("blake3:old", "old")];

    const result = updateRunningContributionSeenState(
      { seenCids: new Set<string>(), initialSeeded: false },
      historical,
      true,
    );

    expect(result.unseen).toEqual([]);
    expect(result.state.initialSeeded).toBe(true);
    expect(result.state.seenCids.has("blake3:old")).toBe(true);
  });

  test("reports only CIDs added after the initial seed", () => {
    const oldContribution = contribution("blake3:old", "old");
    const newContribution = contribution("blake3:new", "new");
    const seeded = updateRunningContributionSeenState(
      { seenCids: new Set<string>(), initialSeeded: false },
      [oldContribution],
      true,
    );

    const result = updateRunningContributionSeenState(
      seeded.state,
      [oldContribution, newContribution],
      true,
    );

    expect(result.unseen).toEqual([newContribution]);
    expect(result.state.seenCids.has("blake3:old")).toBe(true);
    expect(result.state.seenCids.has("blake3:new")).toBe(true);
  });
});
