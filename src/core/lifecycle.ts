/**
 * Contribution lifecycle state derivation and stop condition evaluation.
 *
 * Lifecycle states are derived from the graph structure — they are never
 * stored. Stop conditions are evaluated against the current grove state
 * using the GROVE.md contract and the contribution store.
 *
 * See spec/LIFECYCLE.md for the full specification.
 */

import type { Contribution, RelationType } from "./models.js";
import type { ContributionStore } from "./store.js";

// ---------------------------------------------------------------------------
// Lifecycle States
// ---------------------------------------------------------------------------

/** Lifecycle states in descending precedence order. */
export const LifecycleState = {
  Superseded: "superseded",
  Challenged: "challenged",
  Adopted: "adopted",
  Reproduced: "reproduced",
  UnderReview: "under_review",
  Published: "published",
  Draft: "draft",
} as const;
export type LifecycleState = (typeof LifecycleState)[keyof typeof LifecycleState];

/**
 * Derive the lifecycle state for a single contribution.
 *
 * Queries the store for incoming relations and applies precedence rules.
 * For batch operations, prefer `deriveLifecycleStates()` which loads
 * all data in a single pass.
 *
 * NOTE: The precedence logic here (superseded → challenged → adopted →
 * reproduced → under_review → published) must mirror
 * `deriveStateFromRelations()` below. Update both when adding new states.
 */
export async function deriveLifecycleState(
  cid: string,
  store: ContributionStore,
): Promise<LifecycleState> {
  // Check for superseding derives_from relations
  const derivesFromIncoming = await store.relatedTo(cid, "derives_from" as RelationType);
  for (const c of derivesFromIncoming) {
    for (const rel of c.relations) {
      if (
        rel.targetCid === cid &&
        rel.relationType === "derives_from" &&
        rel.metadata?.relationship === "supersedes"
      ) {
        return LifecycleState.Superseded;
      }
    }
  }

  // Check for challenged reproductions
  const reproducesIncoming = await store.relatedTo(cid, "reproduces" as RelationType);
  let hasConfirmedReproduction = false;
  for (const c of reproducesIncoming) {
    for (const rel of c.relations) {
      if (rel.targetCid === cid && rel.relationType === "reproduces") {
        if (rel.metadata?.result === "challenged") {
          return LifecycleState.Challenged;
        }
        // confirmed, partial, or absent result = confirmed
        hasConfirmedReproduction = true;
      }
    }
  }

  // Check for adopts relations
  const adoptsIncoming = await store.relatedTo(cid, "adopts" as RelationType);
  if (adoptsIncoming.length > 0) {
    return LifecycleState.Adopted;
  }

  // Check for confirmed reproductions (already computed above)
  if (hasConfirmedReproduction) {
    return LifecycleState.Reproduced;
  }

  // Check for reviews relations
  const reviewsIncoming = await store.relatedTo(cid, "reviews" as RelationType);
  if (reviewsIncoming.length > 0) {
    return LifecycleState.UnderReview;
  }

  return LifecycleState.Published;
}

/**
 * Derive lifecycle states for multiple contributions in a single pass.
 *
 * Uses `store.incomingSources(cids)` to load only the contributions that
 * have relations pointing to the given CIDs, avoiding a full store scan.
 * Much more efficient than calling `deriveLifecycleState()` per CID,
 * and O(k) memory where k is the number of incoming edges rather than
 * O(n) where n is the total contribution count.
 */
export async function deriveLifecycleStates(
  cids: readonly string[],
  store: ContributionStore,
): Promise<ReadonlyMap<string, LifecycleState>> {
  if (cids.length === 0) return new Map();

  // Load only contributions that have relations targeting any of the given CIDs
  const incomingContributions = await store.incomingSources(cids);
  const cidSet = new Set(cids);

  // Build incoming relation index: target CID → source contributions by type
  const incomingByType = new Map<string, Map<string, Contribution[]>>();
  for (const cid of cids) {
    incomingByType.set(cid, new Map());
  }

  for (const c of incomingContributions) {
    for (const rel of c.relations) {
      if (cidSet.has(rel.targetCid)) {
        const byType = incomingByType.get(rel.targetCid);
        if (byType === undefined) continue;
        let sources = byType.get(rel.relationType);
        if (sources === undefined) {
          sources = [];
          byType.set(rel.relationType, sources);
        }
        sources.push(c);
      }
    }
  }

  const result = new Map<string, LifecycleState>();

  for (const cid of cids) {
    const byType = incomingByType.get(cid) ?? new Map();
    result.set(cid, deriveStateFromRelations(cid, byType));
  }

  return result;
}

/**
 * Derive lifecycle state from pre-computed incoming relation map.
 *
 * NOTE: The precedence logic here (superseded → challenged → adopted →
 * reproduced → under_review → published) must mirror
 * `deriveLifecycleState()` above. Update both when adding new states.
 */
function deriveStateFromRelations(
  cid: string,
  byType: Map<string, Contribution[]>,
): LifecycleState {
  // Check superseded: derives_from with metadata.relationship === "supersedes"
  const derivesFromSources = byType.get("derives_from") ?? [];
  for (const c of derivesFromSources) {
    for (const rel of c.relations) {
      if (
        rel.targetCid === cid &&
        rel.relationType === "derives_from" &&
        rel.metadata?.relationship === "supersedes"
      ) {
        return LifecycleState.Superseded;
      }
    }
  }

  // Check challenged vs reproduced
  const reproducesSources = byType.get("reproduces") ?? [];
  let hasConfirmedReproduction = false;
  for (const c of reproducesSources) {
    for (const rel of c.relations) {
      if (rel.targetCid === cid && rel.relationType === "reproduces") {
        if (rel.metadata?.result === "challenged") {
          return LifecycleState.Challenged;
        }
        hasConfirmedReproduction = true;
      }
    }
  }

  // Check adopted
  const adoptsSources = byType.get("adopts") ?? [];
  if (adoptsSources.length > 0) {
    return LifecycleState.Adopted;
  }

  // Check reproduced
  if (hasConfirmedReproduction) {
    return LifecycleState.Reproduced;
  }

  // Check under_review
  const reviewsSources = byType.get("reviews") ?? [];
  if (reviewsSources.length > 0) {
    return LifecycleState.UnderReview;
  }

  return LifecycleState.Published;
}

// ---------------------------------------------------------------------------
// Stop Condition Evaluation — re-exported from canonical module
// ---------------------------------------------------------------------------

export type {
  DeliberationResult,
  StopConditionResult,
  StopEvaluationResult,
} from "./stop-conditions.js";
export { evaluateStopConditions } from "./stop-conditions.js";
