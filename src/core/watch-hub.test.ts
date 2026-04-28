import { describe, expect, test } from "bun:test";
import { contributionToEntity } from "./entity.js";
import type { Contribution } from "./models.js";
import { WatchHub } from "./watch-hub.js";

function fixtureContribution(cid: string): Contribution {
  return {
    cid,
    manifestVersion: 1,
    kind: "work",
    mode: "evaluation",
    summary: "fixture",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "a-1" },
    createdAt: new Date().toISOString(),
  };
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

  test("namespaces and kinds maintain independent counters", () => {
    const hub = new WatchHub();
    const ent = contributionToEntity(fixtureContribution("cid-a"), "ns/wt");
    const rvNsA = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/A",
      op: "ADDED",
      entity: ent,
    });
    const rvNsB = hub.recordWrite({
      kind: "Contribution",
      namespace: "ns/B",
      op: "ADDED",
      entity: ent,
    });
    const rvKindClaim = hub.recordWrite({
      kind: "Claim",
      namespace: "ns/A",
      op: "ADDED",
      // Reusing the Contribution entity for shape only; the WatchEvent
      // union accepts it because the test does not exercise claim semantics.
      entity: ent as unknown as never,
    });
    expect(rvNsA).toBe(1n);
    expect(rvNsB).toBe(1n);
    expect(rvKindClaim).toBe(1n);
    expect(hub.currentRv("ns/A", "Contribution")).toBe(1n);
    expect(hub.currentRv("ns/B", "Contribution")).toBe(1n);
    expect(hub.currentRv("ns/A", "Claim")).toBe(1n);
    expect(hub.currentRv("ns/A", "AgentSession")).toBe(0n);
  });
});
