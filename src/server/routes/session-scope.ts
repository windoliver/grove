import type { OperationDeps } from "../../core/operations/deps.js";
import type { ContributionStore } from "../../core/store.js";
import type { ServerDeps } from "../deps.js";
import { toOperationDeps } from "../operation-adapter.js";

export function contributionStoreForSession(
  deps: ServerDeps,
  sessionId: string | undefined,
): ContributionStore {
  if (sessionId !== undefined && deps.contributionStoreForSession !== undefined) {
    return deps.contributionStoreForSession(sessionId);
  }
  return deps.contributionStore;
}

export function operationDepsForSession(
  deps: ServerDeps,
  sessionId: string | undefined,
): OperationDeps {
  const scopedContributionStore = contributionStoreForSession(deps, sessionId);
  const scopedFrontier =
    sessionId !== undefined && deps.frontierForSession !== undefined
      ? deps.frontierForSession(sessionId)
      : deps.frontier;

  return {
    ...toOperationDeps(deps),
    contributionStore: scopedContributionStore,
    frontier: scopedFrontier,
  };
}
