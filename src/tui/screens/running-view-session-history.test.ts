import { describe, expect, test } from "bun:test";
import type { Contribution } from "../../core/models.js";
import type { TuiDataProvider, TuiSessionProvider } from "../provider.js";
import { fetchRunningContributions } from "./running-view.js";

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
});
