/**
 * Activity stream view — paged contributions feed, EntityView-backed.
 *
 * Pagination: sort by createdAt desc, slice via EntityView's offset+limit.
 * Wrapper owns the custom header ("showing N-M") because EntityView's
 * built-in title doesn't model offset display.
 */

import React, { useCallback, useState } from "react";
import { contributionToEntity, type ContributionEntity } from "../../core/entity.js";
import type { Contribution } from "../../core/models.js";

const NAMESPACE = "default";
import {
  agentColumn,
  byCreatedDesc,
  cidColumn,
  createdColumn,
  kindColumn,
  modeColumn,
  summaryColumn,
  tagsColumn,
} from "../components/columns/contribution-columns.js";
import { EntityView } from "../components/entity-view.js";
import type { TuiDataProvider } from "../provider.js";

export interface ActivityProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly pageOffset: number;
  readonly pageSize: number;
  readonly onContributionsLoaded?: (contributions: readonly Contribution[]) => void;
}

const COLUMNS = [
  cidColumn(22),
  kindColumn(14),
  modeColumn(12),
  summaryColumn(36),
  agentColumn(16),
  tagsColumn(16, 3),
  createdColumn("CREATED", 12),
];

function entityToContribution(e: ContributionEntity): Contribution {
  return {
    cid: e.id,
    manifestVersion: 0,
    kind: e.spec.contributionKind,
    mode: e.spec.mode,
    summary: e.spec.summary,
    description: e.spec.description,
    artifacts: e.spec.artifacts,
    relations: e.spec.relations,
    scores: e.spec.scores,
    tags: e.spec.tags,
    context: e.spec.context,
    agent: e.spec.agent,
    createdAt: e.metadata.creationTimestamp ?? "",
  };
}

export const ActivityView: React.NamedExoticComponent<ActivityProps> = React.memo(
  function ActivityView(props: ActivityProps): React.ReactNode {
    const { provider, active, cursor, pageOffset, pageSize, onContributionsLoaded } = props;
    const [count, setCount] = useState(0);

    const onDataChanged = useCallback(
      (entities: readonly ContributionEntity[]) => {
        if (onContributionsLoaded) onContributionsLoaded(entities.map(entityToContribution));
      },
      [onContributionsLoaded],
    );

    // The fallback path owns its own paging/ordering: useEntityData applies
    // ONLY `predicate` to polled data (sort/offset/limit are skipped) so
    // we ask the provider for the exact page we want. Server returns its
    // native order (ascending in the current server) — matches the
    // pre-EntityView behavior of the activity stream's polled path.
    const fallbackFetcher = useCallback(async (): Promise<readonly ContributionEntity[]> => {
      const items = await provider.getActivity({ limit: pageSize, offset: pageOffset });
      return items.map((c) => contributionToEntity(c, NAMESPACE));
    }, [provider, pageOffset, pageSize]);

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Activity Stream</text>
          {count > 0 ? (
            <text opacity={0.5}>{`  showing ${pageOffset + 1}-${pageOffset + count}`}</text>
          ) : pageOffset > 0 ? (
            <text opacity={0.5}>{"  "}(no more results — press p to go back)</text>
          ) : null}
        </box>
        <EntityView
          kind="Contribution"
          columns={COLUMNS}
          provider={provider}
          active={active}
          cursor={cursor}
          sort={byCreatedDesc}
          offset={pageOffset}
          limit={pageSize}
          fallbackFetcher={fallbackFetcher}
          onRowCountChanged={setCount}
          onDataChanged={onDataChanged}
        />
      </box>
    );
  },
);
