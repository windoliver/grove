import { describe, expect, test } from "bun:test";
import type { Contribution } from "../../core/models.js";
import { ClaimStatus, ContributionKind, RelationType } from "../../core/models.js";
import { makeClaim, makeContribution, makeRelation } from "../../core/test-helpers.js";
import { projectDagTree } from "./dag-tree-projection.js";

const NOW = Date.parse("2026-05-11T12:00:00Z");
const FUTURE = new Date(NOW + 60_000).toISOString();

function chain(): { root: Contribution; mid: Contribution; tip: Contribution } {
  const root = makeContribution({ summary: "root", createdAt: "2026-05-11T11:00:00Z" });
  const mid = makeContribution({
    summary: "mid",
    createdAt: "2026-05-11T11:30:00Z",
    relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
  });
  const tip = makeContribution({
    summary: "tip",
    createdAt: "2026-05-11T11:45:00Z",
    relations: [makeRelation({ targetCid: mid.cid, relationType: RelationType.DerivesFrom })],
  });
  return { root, mid, tip };
}

describe("projectDagTree", () => {
  test("empty input → empty result", () => {
    const r = projectDagTree({
      contributions: [],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 500 },
    });
    expect(r.rows).toEqual([]);
    expect(r.nodes.size).toBe(0);
    expect(r.truncated).toBe(false);
  });

  test("linear chain renders root → mid → tip top-down", () => {
    const { root, mid, tip } = chain();
    const r = projectDagTree({
      contributions: [root, mid, tip],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 500 },
    });
    expect(r.rows.map((row) => row.cid)).toEqual([root.cid, mid.cid, tip.cid]);
    expect(r.rows.map((row) => row.depth)).toEqual([0, 1, 2]);
  });

  test("collapsed root hides descendants", () => {
    const { root, mid, tip } = chain();
    const r = projectDagTree({
      contributions: [root, mid, tip],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set([root.cid]), focusCid: null, maxNodes: 500 },
    });
    expect(r.rows.map((row) => row.cid)).toEqual([root.cid]);
    expect(r.rows[0]?.expander).toBe("collapsed");
  });

  test("leaf node has expander='leaf'", () => {
    const { root, mid, tip } = chain();
    const r = projectDagTree({
      contributions: [root, mid, tip],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 500 },
    });
    const tipRow = r.rows.find((row) => row.cid === tip.cid);
    expect(tipRow?.expander).toBe("leaf");
  });

  test("focus rooting limits projection to focus + descendants", () => {
    const { root, mid, tip } = chain();
    const r = projectDagTree({
      contributions: [root, mid, tip],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set(), focusCid: mid.cid, maxNodes: 500 },
    });
    expect(r.rows.map((row) => row.cid)).toEqual([mid.cid, tip.cid]);
  });

  test("review edge appears as a child branch", () => {
    const root = makeContribution({ summary: "work" });
    const review = makeContribution({
      kind: ContributionKind.Review,
      summary: "review of root",
      createdAt: "2026-05-11T11:30:00Z",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.Reviews })],
    });
    const r = projectDagTree({
      contributions: [root, review],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 500 },
    });
    expect(r.rows.map((row) => row.cid)).toEqual([root.cid, review.cid]);
    const reviewRow = r.rows[1];
    expect(reviewRow?.incomingEdge).toBe(RelationType.Reviews);
  });

  test("reproduces edge appears as a child branch", () => {
    const root = makeContribution({ summary: "claim" });
    const repro = makeContribution({
      kind: ContributionKind.Reproduction,
      summary: "repro",
      createdAt: "2026-05-11T11:30:00Z",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.Reproduces })],
    });
    const r = projectDagTree({
      contributions: [root, repro],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 500 },
    });
    expect(r.rows[1]?.incomingEdge).toBe(RelationType.Reproduces);
  });

  test("running status surfaces from active claim", () => {
    const c = makeContribution({ summary: "x" });
    const claim = makeClaim({
      status: ClaimStatus.Active,
      leaseExpiresAt: FUTURE,
      targetRef: c.cid,
    });
    const r = projectDagTree({
      contributions: [c],
      outcomes: new Map(),
      claims: [claim],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 500 },
    });
    expect(r.rows[0]?.node.status).toBe("running");
  });

  test("active claim wins over earlier completed claim for the same target", () => {
    // Under polled status:"all", a stale completed/released row can be
    // listed before the live active one. The projection must NOT let
    // the terminal claim mask the active one — otherwise running/blocked
    // icons silently regress.
    const c = makeContribution({ summary: "x" });
    const completed = makeClaim({
      claimId: "claim-completed",
      status: ClaimStatus.Completed,
      leaseExpiresAt: FUTURE,
      targetRef: c.cid,
    });
    const active = makeClaim({
      claimId: "claim-active",
      status: ClaimStatus.Active,
      leaseExpiresAt: FUTURE,
      targetRef: c.cid,
    });
    const r = projectDagTree({
      contributions: [c],
      outcomes: new Map(),
      claims: [completed, active],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 500 },
    });
    expect(r.rows[0]?.node.status).toBe("running");
  });

  test("respects maxNodes cap with truncated=true", () => {
    const root = makeContribution({ summary: "root" });
    const children = Array.from({ length: 10 }, (_, i) =>
      makeContribution({
        summary: `child-${String(i)}`,
        createdAt: `2026-05-11T11:${String(10 + i).padStart(2, "0")}:00Z`,
        relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
      }),
    );
    const r = projectDagTree({
      contributions: [root, ...children],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 5 },
    });
    expect(r.rows.length).toBe(5);
    expect(r.truncated).toBe(true);
  });

  test("cycle is detected and does not infinite-loop", () => {
    const a = makeContribution({ summary: "a" });
    const b = makeContribution({
      summary: "b",
      createdAt: "2026-05-11T11:30:00Z",
      relations: [makeRelation({ targetCid: a.cid, relationType: RelationType.DerivesFrom })],
    });
    const aWithCycle: Contribution = {
      ...a,
      relations: [{ targetCid: b.cid, relationType: RelationType.DerivesFrom }],
    };
    const r = projectDagTree({
      contributions: [aWithCycle, b],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 500 },
    });
    const seen = new Set<string>();
    for (const row of r.rows) {
      expect(seen.has(row.cid)).toBe(false);
      seen.add(row.cid);
    }
  });

  test("nodes Map is keyed by every contribution cid present", () => {
    const { root, mid, tip } = chain();
    const r = projectDagTree({
      contributions: [root, mid, tip],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 500 },
    });
    expect(r.nodes.size).toBe(3);
    expect(r.nodes.has(root.cid)).toBe(true);
  });

  test("rows array is frozen", () => {
    const { root } = chain();
    const r = projectDagTree({
      contributions: [root],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 500 },
    });
    expect(Object.isFrozen(r.rows)).toBe(true);
  });

  test("shared child with multiple parent edges surfaces under each parent", () => {
    // A work contribution adopted by two different work parents — the
    // shared child must appear under BOTH parents so reviewers see every
    // incoming edge, not just the first DFS path.
    const parentA = makeContribution({
      summary: "parent-A",
      createdAt: "2026-05-11T11:00:00Z",
    });
    const parentB = makeContribution({
      summary: "parent-B",
      createdAt: "2026-05-11T11:05:00Z",
    });
    const child = makeContribution({
      summary: "shared-child",
      createdAt: "2026-05-11T11:30:00Z",
      relations: [
        makeRelation({ targetCid: parentA.cid, relationType: RelationType.Reviews }),
        makeRelation({ targetCid: parentB.cid, relationType: RelationType.Adopts }),
      ],
    });
    const r = projectDagTree({
      contributions: [parentA, parentB, child],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 500 },
    });
    const childRows = r.rows.filter((row) => row.cid === child.cid);
    expect(childRows.length).toBe(2);
    const edges = childRows.map((row) => row.incomingEdge);
    expect(edges).toContain(RelationType.Reviews);
    expect(edges).toContain(RelationType.Adopts);
    // First emission is a full subtree, second is a non-descending crosslink.
    const expanders = childRows.map((row) => row.expander).sort();
    expect(expanders).toEqual(["crosslink", "leaf"]);
  });

  test("rootless cycle still renders each reachable cid (no empty projection)", () => {
    // Forge a closed cycle a→b→a so no node has zero in-set parents.
    // The projection must NOT return an empty rows array — every cid
    // should still be visible to the operator.
    const a = makeContribution({ summary: "cycle-a" });
    const b = makeContribution({
      summary: "cycle-b",
      createdAt: "2026-05-11T11:30:00Z",
      relations: [makeRelation({ targetCid: a.cid, relationType: RelationType.DerivesFrom })],
    });
    const aWithCycle: Contribution = {
      ...a,
      relations: [{ targetCid: b.cid, relationType: RelationType.DerivesFrom }],
    };
    const r = projectDagTree({
      contributions: [aWithCycle, b],
      outcomes: new Map(),
      claims: [],
      now: NOW,
      options: { collapsed: new Set(), focusCid: null, maxNodes: 500 },
    });
    expect(r.rows.length).toBeGreaterThan(0);
    const cids = new Set(r.rows.map((row) => row.cid));
    expect(cids.has(a.cid)).toBe(true);
    expect(cids.has(b.cid)).toBe(true);
  });
});
