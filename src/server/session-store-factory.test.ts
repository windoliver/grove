import { describe, expect, test } from "bun:test";
import { InMemoryContributionStore } from "../core/testing.js";
import { memoizeContributionStoreForSession } from "./session-store-factory.js";

describe("memoizeContributionStoreForSession", () => {
  test("reuses a contribution store per session id", () => {
    const calls: string[] = [];
    const factory = memoizeContributionStoreForSession((sessionId) => {
      calls.push(sessionId);
      return new InMemoryContributionStore();
    });

    const first = factory("session-a");
    const second = factory("session-a");
    const other = factory("session-b");

    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(calls).toEqual(["session-a", "session-b"]);
  });
});
