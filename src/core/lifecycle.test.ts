import { describe, expect, test } from "bun:test";
import { deriveLifecycleState, deriveLifecycleStates, LifecycleState } from "./lifecycle.js";
import type { Contribution } from "./models.js";
import { type ContributionInput, ContributionKind, RelationType } from "./models.js";
import { makeContribution } from "./test-helpers.js";
import { InMemoryContributionStore } from "./testing.js";

// ---------------------------------------------------------------------------
// Helper to create contributions with specific relations
// ---------------------------------------------------------------------------

let uniqueCounter = 0;

function uniqueTimestamp(): string {
  uniqueCounter += 1;
  const hours = Math.floor(uniqueCounter / 3600) % 24;
  const minutes = Math.floor((uniqueCounter % 3600) / 60);
  const seconds = uniqueCounter % 60;
  return `2026-01-01T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}Z`;
}

function makeUniqueContribution(overrides?: Partial<ContributionInput>): Contribution {
  const ts = uniqueTimestamp();
  return makeContribution({
    summary: `Contribution ${uniqueCounter}`,
    createdAt: ts,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle State Derivation
// ---------------------------------------------------------------------------

describe("deriveLifecycleState", () => {
  test("returns 'published' for contribution with no incoming relations", async () => {
    const contrib = makeUniqueContribution();
    const store = new InMemoryContributionStore([contrib]);
    const state = await deriveLifecycleState(contrib.cid, store);
    expect(state).toBe(LifecycleState.Published);
  });

  test("returns 'under_review' when contribution has incoming reviews", async () => {
    const target = makeUniqueContribution({ summary: "Target work" });
    const review = makeUniqueContribution({
      kind: ContributionKind.Review,
      summary: "Review of target",
      relations: [{ targetCid: target.cid, relationType: RelationType.Reviews }],
    });
    const store = new InMemoryContributionStore([target, review]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.UnderReview);
  });

  test("returns 'reproduced' when contribution has confirmed reproduction", async () => {
    const target = makeUniqueContribution({ summary: "Original work" });
    const repro = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Reproduction",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reproduces,
          metadata: { result: "confirmed" },
        },
      ],
    });
    const store = new InMemoryContributionStore([target, repro]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Reproduced);
  });

  test("returns 'reproduced' when reproduction has no metadata (default confirmed)", async () => {
    const target = makeUniqueContribution({ summary: "Original work" });
    const repro = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Reproduction no metadata",
      relations: [{ targetCid: target.cid, relationType: RelationType.Reproduces }],
    });
    const store = new InMemoryContributionStore([target, repro]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Reproduced);
  });

  test("returns 'challenged' when reproduction has result=challenged", async () => {
    const target = makeUniqueContribution({ summary: "Challenged work" });
    const repro = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Challenging reproduction",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reproduces,
          metadata: { result: "challenged" },
        },
      ],
    });
    const store = new InMemoryContributionStore([target, repro]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Challenged);
  });

  test("'challenged' beats 'reproduced' when both exist", async () => {
    const target = makeUniqueContribution({ summary: "Mixed repro" });
    const confirmed = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Confirmed repro",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reproduces,
          metadata: { result: "confirmed" },
        },
      ],
    });
    const challenged = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Challenged repro",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reproduces,
          metadata: { result: "challenged" },
        },
      ],
    });
    const store = new InMemoryContributionStore([target, confirmed, challenged]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Challenged);
  });

  test("returns 'adopted' when contribution has incoming adopts", async () => {
    const target = makeUniqueContribution({ summary: "Adopted work" });
    const adoption = makeUniqueContribution({
      kind: ContributionKind.Adoption,
      summary: "Adoption",
      relations: [{ targetCid: target.cid, relationType: RelationType.Adopts }],
    });
    const store = new InMemoryContributionStore([target, adoption]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Adopted);
  });

  test("'adopted' beats 'reproduced'", async () => {
    const target = makeUniqueContribution({ summary: "Adopted+reproduced" });
    const repro = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Repro",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reproduces,
          metadata: { result: "confirmed" },
        },
      ],
    });
    const adoption = makeUniqueContribution({
      kind: ContributionKind.Adoption,
      summary: "Adoption",
      relations: [{ targetCid: target.cid, relationType: RelationType.Adopts }],
    });
    const store = new InMemoryContributionStore([target, repro, adoption]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Adopted);
  });

  test("returns 'superseded' when derives_from has metadata.relationship=supersedes", async () => {
    const target = makeUniqueContribution({ summary: "Superseded work" });
    const newer = makeUniqueContribution({
      summary: "Superseding work",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.DerivesFrom,
          metadata: { relationship: "supersedes" },
        },
      ],
    });
    const store = new InMemoryContributionStore([target, newer]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Superseded);
  });

  test("'superseded' beats 'challenged'", async () => {
    const target = makeUniqueContribution({ summary: "Superseded+challenged" });
    const challenged = makeUniqueContribution({
      kind: ContributionKind.Reproduction,
      summary: "Challenge",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.Reproduces,
          metadata: { result: "challenged" },
        },
      ],
    });
    const superseder = makeUniqueContribution({
      summary: "Superseder",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.DerivesFrom,
          metadata: { relationship: "supersedes" },
        },
      ],
    });
    const store = new InMemoryContributionStore([target, challenged, superseder]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Superseded);
  });

  test("normal derives_from does NOT cause superseded", async () => {
    const target = makeUniqueContribution({ summary: "Extended work" });
    const derived = makeUniqueContribution({
      summary: "Derived work",
      relations: [
        {
          targetCid: target.cid,
          relationType: RelationType.DerivesFrom,
          metadata: { relationship: "extension" },
        },
      ],
    });
    const store = new InMemoryContributionStore([target, derived]);
    const state = await deriveLifecycleState(target.cid, store);
    expect(state).toBe(LifecycleState.Published);
  });
});

// ---------------------------------------------------------------------------
// Batch lifecycle state derivation
// ---------------------------------------------------------------------------

describe("deriveLifecycleStates", () => {
  test("returns empty map for empty input", async () => {
    const store = new InMemoryContributionStore();
    const states = await deriveLifecycleStates([], store);
    expect(states.size).toBe(0);
  });

  test("derives states for multiple contributions in one pass", async () => {
    const published = makeUniqueContribution({ summary: "Published" });
    const reviewed = makeUniqueContribution({ summary: "Reviewed" });
    const review = makeUniqueContribution({
      kind: ContributionKind.Review,
      summary: "A review",
      relations: [{ targetCid: reviewed.cid, relationType: RelationType.Reviews }],
    });

    const store = new InMemoryContributionStore([published, reviewed, review]);
    const states = await deriveLifecycleStates([published.cid, reviewed.cid], store);

    expect(states.get(published.cid)).toBe(LifecycleState.Published);
    expect(states.get(reviewed.cid)).toBe(LifecycleState.UnderReview);
  });
});

// Stop condition tests have been moved to stop-conditions.test.ts
// to co-locate with the canonical evaluator in stop-conditions.ts.
