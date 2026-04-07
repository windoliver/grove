/**
 * Plan panel view — displays the latest plan's task list.
 */

import React, { useCallback } from "react";
import type { Contribution } from "../../core/models.js";
import { formatTimestamp } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { usePanelState } from "../hooks/use-panel-state.js";
import type { TuiDataProvider } from "../provider.js";

/** Props for the PlanPanel view. */
export interface PlanPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
}

/** A single task within a plan (matches the context.tasks shape). */
interface PlanTask {
  readonly id: string;
  readonly title: string;
  readonly status: "todo" | "in_progress" | "done" | "blocked";
  readonly assignee?: string;
}

const COLUMNS = [
  { header: "ID", key: "id", width: 12 },
  { header: "TITLE", key: "title", width: 36 },
  { header: "STATUS", key: "status", width: 14 },
  { header: "ASSIGNEE", key: "assignee", width: 16 },
] as const;

const STATUS_ICON: Record<string, string> = {
  todo: "[ ]",
  in_progress: "[~]",
  done: "[x]",
  blocked: "[!]",
};

/** Plan panel view component. */
export const PlanPanelView: React.NamedExoticComponent<PlanPanelProps> = React.memo(
  function PlanPanelView({
    provider,
    intervalMs,
    active,
    cursor,
  }: PlanPanelProps): React.ReactNode {
    const fetcher = useCallback(
      () => provider.getActivity({ kind: "plan" as Contribution["kind"] }),
      [provider],
    );
    const { state } = usePanelState<readonly Contribution[]>(fetcher, intervalMs, active);

    if (state.status === "loading") {
      return (
        <box>
          <text opacity={0.5}>Loading plan...</text>
        </box>
      );
    }

    if (state.status === "error") {
      return (
        <box flexDirection="column">
          <box marginBottom={1} flexDirection="row">
            <text>Plan</text>
            <DataStatus loading={false} isStale={false} error={state.error.message} />
          </box>
          <EmptyState title="Failed to load plan." />
        </box>
      );
    }

    // state.status === "ready"
    const { data: contributions, isStale, error } = state;

    // list() returns ASC order — take the last entry for the newest plan
    const latest =
      contributions.length > 0 ? contributions[contributions.length - 1] : undefined;

    if (!latest) {
      return (
        <box flexDirection="column">
          <box marginBottom={1} flexDirection="row">
            <text>Plan</text>
            <DataStatus loading={false} isStale={isStale} error={error?.message} />
          </box>
          <EmptyState
            title="No plan found."
            hint="Use grove_create_plan to create one."
          />
        </box>
      );
    }

    const tasks = (latest.context?.tasks as unknown as PlanTask[]) ?? [];
    const title = (latest.context?.plan_title as string) ?? "Untitled Plan";
    const done = tasks.filter((t) => t?.status === "done").length;

    const rows = tasks.filter(Boolean).map((t) => ({
      id: t.id ?? "-",
      title: (t.title ?? "").length > 36 ? `${(t.title ?? "").slice(0, 34)}..` : (t.title ?? ""),
      status: `${STATUS_ICON[t.status] ?? "[ ]"} ${t.status ?? "unknown"}`,
      assignee: t.assignee ?? "-",
    }));

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text bold>{`Plan: ${title}`}</text>
          <DataStatus loading={false} isStale={isStale} error={error?.message} />
          <text opacity={0.5}>
            {`  ${done}/${tasks.length} done  |  ${formatTimestamp(latest.createdAt)}`}
          </text>
        </box>
        <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
      </box>
    );
  },
);
