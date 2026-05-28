import type { Contribution } from "../../core/models.js";
import type { TuiDataProvider } from "../provider.js";
import { isSessionProvider } from "../provider.js";

export async function fetchRunningContributions(
  provider: TuiDataProvider,
  sessionId: string | undefined,
): Promise<readonly Contribution[]> {
  if (sessionId !== undefined && isSessionProvider(provider)) {
    return provider.getSessionContributions(sessionId);
  }
  return provider.getContributions();
}

export interface RunningContributionSeenState {
  readonly seenCids: ReadonlySet<string>;
  readonly initialSeeded: boolean;
}

export interface RunningContributionSeenUpdate {
  readonly state: RunningContributionSeenState;
  readonly unseen: readonly Contribution[];
  readonly seededInitialFeed: boolean;
}

export function updateRunningContributionSeenState(
  state: RunningContributionSeenState,
  feed: readonly Contribution[],
  seedInitialFeed: boolean,
): RunningContributionSeenUpdate {
  if (feed.length === 0) {
    return { state, unseen: [], seededInitialFeed: false };
  }

  const seenCids = new Set(state.seenCids);
  if (!state.initialSeeded && seedInitialFeed) {
    for (const contribution of feed) {
      seenCids.add(contribution.cid);
    }
    return {
      state: { seenCids, initialSeeded: true },
      unseen: [],
      seededInitialFeed: true,
    };
  }

  const unseen: Contribution[] = [];
  for (const contribution of feed) {
    if (!seenCids.has(contribution.cid)) {
      seenCids.add(contribution.cid);
      unseen.push(contribution);
    }
  }

  return {
    state: { seenCids, initialSeeded: true },
    unseen,
    seededInitialFeed: false,
  };
}
