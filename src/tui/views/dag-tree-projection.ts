/**
 * Pure DAG tree projection for the xray-style TUI view (issue #311 C5).
 *
 * Input: a flat array of contributions (any order), optional outcomes and
 * active claims indexed by cid, and a `ProjectOptions` model carrying the
 * collapsed-cid set, focus cid, and max-node cap.
 *
 * Output: a flat `Map<cid, DagNode>` together with a depth-first row list
 * that respects the collapsed set. Cycle-safe and bounded.
 *
 * Edge types: derives_from, adopts, reviews, reproduces all count as
 * tree edges. A child's `incomingEdge` records which relation linked it
 * to its parent so the renderer can label review and reproduction
 * branches.
 */

import type { Claim, Contribution, RelationType } from "../../core/models.js";
import type { OutcomeRecord } from "../../core/outcome.js";
import { compareTimestampsDesc } from "../../shared/format.js";
import { type DagNodeStatus, deriveDagStatus } from "./derive-dag-status.js";

const EDGE_RELATION_TYPES: ReadonlySet<RelationType> = new Set([
  "derives_from",
  "adopts",
  "reviews",
  "reproduces",
]);

export interface DagNode {
  readonly cid: string;
  readonly kind: string;
  readonly summary: string;
  readonly agentLabel: string;
  readonly status: DagNodeStatus;
  readonly parents: readonly { readonly cid: string; readonly relationType: RelationType }[];
  readonly children: readonly { readonly cid: string; readonly relationType: RelationType }[];
}

export interface RenderRow {
  readonly cid: string;
  readonly depth: number;
  readonly expander: "expanded" | "collapsed" | "leaf";
  readonly incomingEdge: RelationType | null;
  readonly node: DagNode;
}

export interface ProjectOptions {
  readonly collapsed: ReadonlySet<string>;
  readonly focusCid: string | null;
  readonly maxNodes: number;
}

export interface ProjectInput {
  readonly contributions: readonly Contribution[];
  readonly outcomes: ReadonlyMap<string, OutcomeRecord>;
  readonly claims: readonly Claim[];
  readonly now: number;
  readonly options: ProjectOptions;
}

export interface ProjectResult {
  readonly nodes: ReadonlyMap<string, DagNode>;
  readonly rows: readonly RenderRow[];
  readonly truncated: boolean;
}

function agentLabelOf(c: Contribution): string {
  return c.agent?.role ?? c.agent?.agentName ?? c.agent?.agentId ?? "";
}

export function projectDagTree(input: ProjectInput): ProjectResult {
  const { contributions, outcomes, claims, now, options } = input;
  const cidSet = new Set(contributions.map((c) => c.cid));

  const claimByTarget = new Map<string, Claim>();
  for (const claim of claims) {
    if (!claimByTarget.has(claim.targetRef)) {
      claimByTarget.set(claim.targetRef, claim);
    }
  }

  const parentsByCid = new Map<
    string,
    { readonly cid: string; readonly relationType: RelationType }[]
  >();
  const childrenByCid = new Map<
    string,
    { readonly cid: string; readonly relationType: RelationType }[]
  >();
  for (const c of contributions) {
    const parents: { readonly cid: string; readonly relationType: RelationType }[] = [];
    for (const r of c.relations) {
      if (!EDGE_RELATION_TYPES.has(r.relationType)) continue;
      if (!cidSet.has(r.targetCid)) continue;
      parents.push({ cid: r.targetCid, relationType: r.relationType });
    }
    parentsByCid.set(c.cid, parents);
    if (!childrenByCid.has(c.cid)) childrenByCid.set(c.cid, []);
  }
  for (const c of contributions) {
    const parents = parentsByCid.get(c.cid) ?? [];
    for (const p of parents) {
      const bucket = childrenByCid.get(p.cid);
      if (bucket) bucket.push({ cid: c.cid, relationType: p.relationType });
    }
  }

  const contribByCid = new Map(contributions.map((c) => [c.cid, c]));
  for (const [, list] of childrenByCid) {
    list.sort((a, b) =>
      compareTimestampsDesc(contribByCid.get(a.cid)?.createdAt, contribByCid.get(b.cid)?.createdAt),
    );
  }

  const hasReviewChild = new Map<string, boolean>();
  for (const [cid, kids] of childrenByCid) {
    hasReviewChild.set(
      cid,
      kids.some((k) => k.relationType === "reviews"),
    );
  }

  const nodes = new Map<string, DagNode>();
  for (const c of contributions) {
    const status = deriveDagStatus({
      contribution: c,
      outcome: outcomes.get(c.cid),
      claim: claimByTarget.get(c.cid),
      hasReviewChild: hasReviewChild.get(c.cid) ?? false,
      now,
    });
    nodes.set(c.cid, {
      cid: c.cid,
      kind: c.kind,
      summary: c.summary ?? "",
      agentLabel: agentLabelOf(c),
      status,
      parents: Object.freeze([...(parentsByCid.get(c.cid) ?? [])]),
      children: Object.freeze([...(childrenByCid.get(c.cid) ?? [])]),
    });
  }

  let roots: { readonly cid: string; readonly relationType: RelationType | null }[];
  if (options.focusCid && nodes.has(options.focusCid)) {
    roots = [{ cid: options.focusCid, relationType: null }];
  } else {
    const rootCids = [...nodes.keys()].filter((cid) => (parentsByCid.get(cid)?.length ?? 0) === 0);
    rootCids.sort((a, b) =>
      compareTimestampsDesc(contribByCid.get(a)?.createdAt, contribByCid.get(b)?.createdAt),
    );
    roots = rootCids.map((cid) => ({ cid, relationType: null }));
  }

  const visited = new Set<string>();
  const rows: RenderRow[] = [];
  let truncated = false;

  type Frame = {
    readonly cid: string;
    readonly depth: number;
    readonly incomingEdge: RelationType | null;
  };

  const stack: Frame[] = [];
  for (let i = roots.length - 1; i >= 0; i--) {
    const root = roots[i];
    if (root) stack.push({ cid: root.cid, depth: 0, incomingEdge: root.relationType });
  }

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    if (visited.has(frame.cid)) continue;
    const node = nodes.get(frame.cid);
    if (!node) continue;
    visited.add(frame.cid);

    if (rows.length >= options.maxNodes) {
      truncated = true;
      break;
    }

    const isLeaf = node.children.length === 0;
    const isCollapsed = !isLeaf && options.collapsed.has(frame.cid);
    rows.push({
      cid: frame.cid,
      depth: frame.depth,
      expander: isLeaf ? "leaf" : isCollapsed ? "collapsed" : "expanded",
      incomingEdge: frame.incomingEdge,
      node,
    });

    if (!isLeaf && !isCollapsed) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child)
          stack.push({
            cid: child.cid,
            depth: frame.depth + 1,
            incomingEdge: child.relationType,
          });
      }
    }
  }

  return {
    nodes,
    rows: Object.freeze(rows),
    truncated,
  };
}
