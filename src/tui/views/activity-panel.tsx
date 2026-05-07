/**
 * Activity panel — recent contributions, EntityView-backed.
 */

import React, { useCallback } from "react";
import { contributionToEntity, type ContributionEntity } from "../../core/entity.js";
import {
  agentColumn,
  byCreatedDesc,
  cidColumn,
  createdColumn,
  kindColumn,
  summaryColumn,
  tagsColumn,
} from "../components/columns/contribution-columns.js";
import { EntityView } from "../components/entity-view.js";
import type { TuiDataProvider } from "../provider.js";

export interface ActivityPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: ((count: number) => void) | undefined;
}

const NAMESPACE = "default";

const COLUMNS = [
  cidColumn(16),
  kindColumn(12),
  summaryColumn(32),
  agentColumn(14),
  tagsColumn(14, 2),
  createdColumn("TIME", 10),
];

const PANEL_LIMIT = 30;

export const ActivityPanelView: React.NamedExoticComponent<ActivityPanelProps> = React.memo(
  function ActivityPanelView(props: ActivityPanelProps): React.ReactNode {
    const fallbackFetcher = useCallback(async (): Promise<readonly ContributionEntity[]> => {
      const items = await props.provider.getActivity({ limit: PANEL_LIMIT });
      return items.map((c) => contributionToEntity(c, NAMESPACE));
    }, [props.provider]);

    return (
      <EntityView
        kind="Contribution"
        columns={COLUMNS}
        provider={props.provider}
        active={props.active}
        cursor={props.cursor}
        sort={byCreatedDesc}
        limit={PANEL_LIMIT}
        fallbackFetcher={fallbackFetcher}
        title="Activity"
        emptyTitle="No recent activity."
        emptyHint="Activity appears as agents publish contributions."
        {...(props.onRowCountChanged ? { onRowCountChanged: props.onRowCountChanged } : {})}
      />
    );
  },
);
