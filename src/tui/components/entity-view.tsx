/**
 * EntityView<K> — generic kind-parameterized list view.
 *
 * Replaces the duplicated dual-path data wiring across claims,
 * agent-list, activity, and activity-panel. Owns:
 *   - data fetch (via useEntityData)
 *   - row mapping from columns[].render(entity)
 *   - title/count header (DataStatus)
 *   - empty state
 *   - cursor → onSelect / onRowCountChanged / onDataChanged
 *
 * Does NOT install keyboard handlers. `hints` is metadata for the
 * C3 hint bar (#309) and C2 command prompt (#302). Mutation goes
 * through confirmAndMutate (C6, #304), not EntityView.
 */

import React, { useEffect, useMemo } from "react";
import type { EntityForKind } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { useEntityData } from "../hooks/use-entity-data.js";
import { DataStatus } from "./data-status.js";
import { EmptyState } from "./empty-state.js";
import { Table, type TableColumn } from "./table.js";

export interface EntityColumn<E> {
  readonly header: string;
  readonly key: string;
  readonly width?: number;
  readonly align?: "left" | "right";
  readonly render: (entity: E) => string;
}

export interface EntityHint {
  readonly key: string;
  readonly label: string;
}

export interface EntityViewProps<K extends WatchKind> {
  readonly kind: K;
  readonly columns: readonly EntityColumn<EntityForKind<K>>[];
  readonly provider: unknown;
  readonly active: boolean;
  readonly cursor: number;

  readonly predicate?: (e: EntityForKind<K>) => boolean;
  readonly sort?: (a: EntityForKind<K>, b: EntityForKind<K>) => number;
  readonly offset?: number;
  readonly limit?: number;
  readonly fallbackFetcher?: () => Promise<readonly EntityForKind<K>[]>;

  readonly title?: string;
  readonly headerSuffix?: React.ReactNode;
  readonly emptyTitle?: string;
  readonly emptyHint?: string;

  readonly onRowCountChanged?: (n: number) => void;
  readonly onSelect?: (entity: EntityForKind<K> | undefined) => void;
  readonly onDataChanged?: (data: readonly EntityForKind<K>[]) => void;

  readonly hints?: readonly EntityHint[];
}

const MAX_ROWS = 500;

function EntityViewInner<K extends WatchKind>(props: EntityViewProps<K>): React.ReactNode {
  const {
    kind,
    columns,
    provider,
    active,
    cursor,
    predicate,
    sort,
    offset,
    limit,
    fallbackFetcher,
    title,
    headerSuffix,
    emptyTitle,
    emptyHint,
    onRowCountChanged,
    onSelect,
    onDataChanged,
  } = props;

  const opts: Parameters<typeof useEntityData<K>>[2] = {
    active,
    ...(predicate !== undefined ? { predicate } : {}),
    ...(sort !== undefined ? { sort } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(fallbackFetcher !== undefined ? { fallbackFetcher } : {}),
  };

  const { data, loading, isStale, error } = useEntityData<K>(provider, kind, opts);

  const rows = useMemo<readonly Record<string, string>[]>(
    () =>
      data.map((entity) => {
        const row: Record<string, string> = {};
        for (const col of columns) row[col.key] = col.render(entity);
        return row;
      }),
    [data, columns],
  );

  const tableColumns = useMemo<readonly TableColumn[]>(
    () =>
      columns.map((c) => ({
        header: c.header,
        key: c.key,
        width: c.width,
        align: c.align,
      })),
    [columns],
  );

  useEffect(() => {
    if (onRowCountChanged) onRowCountChanged(data.length);
  }, [data.length, onRowCountChanged]);

  useEffect(() => {
    if (!onSelect) return;
    onSelect(cursor >= 0 && cursor < data.length ? data[cursor] : undefined);
  }, [cursor, data, onSelect]);

  useEffect(() => {
    if (onDataChanged) onDataChanged(data);
  }, [data, onDataChanged]);

  if (loading && data.length === 0) {
    return (
      <box>
        <text opacity={0.5}>{`Loading ${String(kind).toLowerCase()}...`}</text>
      </box>
    );
  }

  return (
    <box flexDirection="column">
      {title !== undefined && (
        <box marginBottom={1} flexDirection="row">
          <text>{`${title} (${data.length})`}</text>
          <DataStatus loading={false} isStale={isStale} error={error?.message} />
          {headerSuffix}
        </box>
      )}
      {data.length === 0 ? (
        <EmptyState
          title={emptyTitle ?? `No ${String(kind).toLowerCase()}.`}
          {...(emptyHint ? { hint: emptyHint } : {})}
        />
      ) : (
        <Table columns={[...tableColumns]} rows={rows} cursor={cursor} maxRows={MAX_ROWS} />
      )}
    </box>
  );
}

export const EntityView = React.memo(EntityViewInner) as <K extends WatchKind>(
  props: EntityViewProps<K>,
) => React.ReactNode;
