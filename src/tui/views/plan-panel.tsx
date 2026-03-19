/**
 * Plan panel view — displays the latest plan's task list.
 */

import React, { useCallback } from "react";
import type { Contribution } from "../../core/models.js";
import { formatTimestamp } from "../../shared/format.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
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
    const { data, loading } = usePolledData<readonly Contribution[]>(fetcher, intervalMs, active);

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading plan...</text>
        </box>
      );
    }

    // list() returns ASC order — take the last entry for the newest plan
    const contributions = data ?? [];
    const latest = contributions.length > 0 ? contributions[contributions.length - 1] : undefined;
    if (!latest) {
      return (
        <box>
          <text opacity={0.5}>No plan found. Use grove_create_plan to create one.</text>
        </box>
      );
    }

    const tasks = (latest.context?.tasks as unknown as PlanTask[]) ?? [];
    const title = (latest.context?.plan_title as string) ?? "Untitled Plan";
    const done = tasks.filter((t) => t.status === "done").length;

    const rows = tasks.map((t) => ({
      id: t.id,
      title: t.title.length > 36 ? `${t.title.slice(0, 34)}..` : t.title,
      status: `${STATUS_ICON[t.status] ?? "[ ]"} ${t.status}`,
      assignee: t.assignee ?? "-",
    }));

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text bold>{`Plan: ${title}`}</text>
          <text opacity={0.5}>
            {`  ${done}/${tasks.length} done  |  ${formatTimestamp(latest.createdAt)}`}
          </text>
        </box>
        <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
      </box>
    );
  },
);
