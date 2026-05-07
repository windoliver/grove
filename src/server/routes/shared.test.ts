import { describe, expect, test } from "bun:test";
import type { Contribution } from "../../core/models.js";
import type {
  ContributionPutManyOutcome,
  ContributionPutOutcome,
  ContributionStore,
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
});
