import { describe, expect, test } from "bun:test";
import { contributionToEntity } from "./entity.js";
import type { Contribution } from "./models.js";
import { WatchHub } from "./watch-hub.js";

function fixtureContribution(cid: string): Contribution {
  return {
    cid,
    kind: "work",
    mode: "evaluation",
    summary: "fixture",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "a-1" },
    createdAt: new Date().toISOString(),
  } as Contribution;
}

describe("WatchHub.recordWrite", () => {
  test("returns strictly increasing rv for same (ns, kind)", () => {
    const hub = new WatchHub();
    const ent1 = contributionToEntity(fixtureContribution("cid-a"), "ns/wt");
    const ent2 = contributionToEntity(fixtureContribution("cid-b"), "ns/wt");
    const rv1 = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: ent1,
    });
    const rv2 = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/wt",
      op: "ADDED",
      entity: ent2,
    });
    expect(rv2 > rv1).toBe(true);
  });
});
