/**
 * Agent task panel — read-only view of trigger-neutral task lifecycle records.
 */

import React, { useCallback, useMemo } from "react";
import type { AgentTaskEntity, AgentTaskView } from "../../core/agent-task.js";
import { agentTaskViewToEntity, isAgentTaskSpecStale } from "../../core/agent-task.js";
import { formatTimestamp } from "../../shared/format.js";
import { ConditionChips } from "../components/condition-chips.js";
import { EmptyState } from "../components/empty-state.js";
import { Table, type TableColumn } from "../components/table.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { TuiDataProvider } from "../provider.js";
import { theme } from "../theme.js";

export interface AgentTasksViewProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
}

const COLUMNS: readonly TableColumn[] = [
  { header: "TASK", key: "task", width: 18 },
  { header: "ROLE", key: "role", width: 12 },
  { header: "RUNTIME", key: "runtime", width: 10 },
  { header: "PHASE", key: "phase", width: 24 },
  { header: "DEPS", key: "deps", width: 6, align: "right" },
  { header: "PROMPT", key: "prompt", width: 36 },
];

function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 2)}..` : s;
}

export function staleSpecBadge(entity: AgentTaskEntity): string {
  return isAgentTaskSpecStale(entity) ? "stale spec" : "";
}

export function renderTaskPhase(entity: AgentTaskEntity): string {
  const badge = staleSpecBadge(entity);
  return badge.length === 0 ? entity.status.phase : `${entity.status.phase} ${badge}`;
}

function viewToEntity(view: AgentTaskView): AgentTaskEntity {
  return agentTaskViewToEntity(view, "default");
}

export const AgentTasksView: React.NamedExoticComponent<AgentTasksViewProps> = React.memo(
  function AgentTasksView({ provider, active, cursor }: AgentTasksViewProps): React.ReactNode {
    const fetcher = useCallback(async (): Promise<readonly AgentTaskView[]> => {
      return provider.getAgentTasks ? provider.getAgentTasks() : [];
    }, [provider]);
    const { data, loading, isStale, error } = useEventDrivenData<readonly AgentTaskView[]>(
      fetcher,
      undefined,
      undefined,
      active,
    );

    const entities = useMemo(() => (data ?? []).map(viewToEntity), [data]);
    const selected = cursor >= 0 && cursor < entities.length ? entities[cursor] : undefined;
    const rows = useMemo(
      () =>
        entities.map((entity) => ({
          task: trunc(entity.id, 18),
          role: trunc(entity.spec.role, 12),
          runtime: trunc(entity.spec.runtime, 10),
          phase: renderTaskPhase(entity),
          deps: String(entity.spec.dependsOn.length),
          prompt: trunc(entity.spec.prompt, 36),
        })),
      [entities],
    );

    if (loading && entities.length === 0) {
      return (
        <box>
          <text opacity={0.5}>Loading agent tasks...</text>
        </box>
      );
    }

    if (entities.length === 0) {
      return (
        <EmptyState
          title="No agent tasks."
          hint="Trigger adapters will create AgentTask records as they come online."
        />
      );
    }

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>{`Agent Tasks (${entities.length})`}</text>
          {isStale && <text color={theme.stale}> [stale]</text>}
          {error && <text color={theme.error}> [{error.message}]</text>}
        </box>
        <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} maxRows={200} />
        {selected && (
          <box flexDirection="column" marginTop={1}>
            <ConditionChips conditions={selected.conditions} />
            <text color={theme.secondary}>
              {`created ${formatTimestamp(selected.metadata.creationTimestamp ?? "")} | generation ${selected.metadata.generation} | observed ${selected.status.observedGeneration}`}
            </text>
          </box>
        )}
      </box>
    );
  },
);
