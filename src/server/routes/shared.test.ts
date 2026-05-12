import { describe, expect, test } from "bun:test";
import type { Contribution } from "../../core/models.js";
import type {
  ContributionPutManyOutcome,
  ContributionPutOutcome,
  ContributionStore,
  CountSinceQuery,
} from "../../core/store.js";
import { makeContribution } from "../../core/test-helpers.js";
import type { ServerDeps } from "../deps.js";
import { contributionStoreForSession } from "./shared.js";

function stubStore(
  contribution: Contribution,
  putResult: ContributionPutOutcome,
  putManyResult: ContributionPutManyOutcome,
): ContributionStore {
  return {
    put: async () => putResult,
    putMany: async () => putManyResult,
    get: async () => contribution,
    getMany: async () => new Map([[contribution.cid, contribution]]),
    list: async () => [contribution],
    children: async () => [],
    incomingSources: async () => [],
    ancestors: async () => [],
    relationsOf: async () => [],
    relatedTo: async () => [],
    search: async () => [],
    findExisting: async () => [],
    count: async () => 1,
    countSince: async () => 1,
    thread: async () => [],
    replyCounts: async () => new Map(),
    hotThreads: async () => [],
    listEntities: async () => [],
    close: () => undefined,
  };
}

describe("contributionStoreForSession fallback wrapper", () => {
  test("put preserves inner store duplicate metadata", async () => {
    const contribution = makeContribution({ summary: "session duplicate" });
    const putResult = { cid: contribution.cid, isNew: false, contribution };
    const inner = stubStore(contribution, putResult, []);

    const scoped = contributionStoreForSession({ contributionStore: inner } as ServerDeps, "s1");

    expect(await scoped.put(contribution)).toEqual(putResult);
  });

  test("putMany preserves inner store duplicate metadata", async () => {
    const contribution = makeContribution({ summary: "session duplicate batch" });
    const putManyResult = [{ cid: contribution.cid, isNew: false, contribution }];
    const inner = stubStore(contribution, undefined, putManyResult);

    const scoped = contributionStoreForSession({ contributionStore: inner } as ServerDeps, "s1");

    expect(await scoped.putMany([contribution])).toEqual(putManyResult);
  });

  test("countSince delegates with sessionId instead of materializing a list", async () => {
    const contribution = makeContribution({ summary: "session counted" });
    let listCalls = 0;
    let countSinceQuery: CountSinceQuery | undefined;
    const inner: ContributionStore = {
      ...stubStore(contribution, undefined, []),
      list: async () => {
        listCalls++;
        return [contribution];
      },
      countSince: async (query) => {
        countSinceQuery = query;
        return 7;
      },
    };

    const scoped = contributionStoreForSession({ contributionStore: inner } as ServerDeps, "s1");
    const count = await scoped.countSince({
      agentId: "agent-1",
      since: "2026-01-01T00:00:00.000Z",
    });

    expect(count).toBe(7);
    expect(countSinceQuery).toEqual({
      agentId: "agent-1",
      since: "2026-01-01T00:00:00.000Z",
      sessionId: "s1",
    });
    expect(listCalls).toBe(0);
  });
});
