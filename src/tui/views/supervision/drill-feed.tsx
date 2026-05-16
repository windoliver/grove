/**
 * DrillFeed — recent contributions for a single agent.
 *
 * Reads from the provider via useEventDrivenData and filters client-side
 * by agent.agentId. Lightweight — does not implement the running-view's
 * highlight, filter, or expand machinery. Drill-dock callers can fall
 * back to the global running-view feed when they need those features.
 */

import React, { useCallback } from "react";
import type { Contribution } from "../../../core/models.js";
import { compareTimestampsDesc, formatTimestamp } from "../../../shared/format.js";
import { EmptyState } from "../../components/empty-state.js";
import { useEventDrivenData } from "../../hooks/use-event-driven-data.js";
import type { TuiDataProvider } from "../../provider.js";
import { theme } from "../../theme.js";

const FEED_LIMIT = 50;

export interface DrillFeedProps {
  readonly provider: TuiDataProvider;
  readonly scopedAgentId: string;
  readonly active: boolean;
}

export const DrillFeed: React.NamedExoticComponent<DrillFeedProps> = React.memo(
  function DrillFeed({ provider, scopedAgentId, active }: DrillFeedProps) {
    const fetcher = useCallback(async () => {
      return await provider.getContributions({ limit: 200 });
    }, [provider]);
    const { data } = useEventDrivenData<readonly Contribution[]>(
      fetcher,
      undefined,
      undefined,
      active,
    );
    const scoped = (data ?? [])
      .filter((c) => c.agent.agentId === scopedAgentId)
      .sort((a, b) => compareTimestampsDesc(a.createdAt, b.createdAt))
      .slice(0, FEED_LIMIT);

    if (scoped.length === 0) {
      return <EmptyState title="No contributions yet." hint="" />;
    }

    return (
      <box flexDirection="column">
        {scoped.map((c) => (
          <box key={c.cid} flexDirection="row" gap={1}>
            <text color={theme.secondary}>{formatTimestamp(c.createdAt)}</text>
            <text>{c.summary}</text>
          </box>
        ))}
      </box>
    );
  },
);
