/**
 * Decisions panel — pending ask-user questions.
 *
 * Shows pending questions from agents awaiting user input if the provider
 * exposes a TuiAskUserProvider-compatible interface. Falls back to a
 * "not available" message following the same pattern as gossip-panel.tsx.
 */

import React, { useCallback, useEffect } from "react";
import { formatTimestamp } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { PendingQuestion, TuiAskUserProvider, TuiDataProvider } from "../provider.js";

/** Props for the DecisionsPanel view. */
export interface DecisionsPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: ((count: number) => void) | undefined;
}

interface DecisionRow {
  readonly cid: string;
  readonly agent: string;
  readonly question: string;
  readonly options: string;
  readonly time: string;
}

const COLUMNS = [
  { header: "AGENT", key: "agent", width: 16 },
  { header: "QUESTION", key: "question", width: 36 },
  { header: "OPTIONS", key: "options", width: 20 },
  { header: "TIME", key: "time", width: 12 },
] as const;

/** Check if a provider exposes a getPendingQuestions method. */
function hasAskUser(provider: TuiDataProvider): provider is TuiDataProvider & TuiAskUserProvider {
  return (
    "getPendingQuestions" in provider &&
    typeof (provider as unknown as TuiAskUserProvider).getPendingQuestions === "function"
  );
}

/** Decisions panel showing pending ask-user questions. */
export const DecisionsPanelView: React.NamedExoticComponent<DecisionsPanelProps> = React.memo(
  function DecisionsPanelView({
    provider,
    intervalMs,
    active,
    cursor,
    onRowCountChanged,
  }: DecisionsPanelProps): React.ReactNode {
    const supportsAskUser = hasAskUser(provider);

    const fetcher = useCallback(async (): Promise<readonly DecisionRow[]> => {
      if (!supportsAskUser) return [];

      const questions: readonly PendingQuestion[] = await (
        provider as unknown as TuiAskUserProvider
      ).getPendingQuestions();
      return questions.map((q) => ({
        cid: q.cid,
        agent:
          (q.agentName ?? "unknown").length > 16
            ? `${(q.agentName ?? "unknown").slice(0, 14)}..`
            : (q.agentName ?? "unknown"),
        question: q.question.length > 36 ? `${q.question.slice(0, 34)}..` : q.question,
        options: q.options ? q.options.join(", ") : "-",
        time: formatTimestamp(q.createdAt),
      }));
    }, [provider, supportsAskUser]);

    const { data, loading, isStale, error } = usePolledData<readonly DecisionRow[]>(
      fetcher,
      intervalMs,
      active,
    );

    useEffect(() => {
      if (data && onRowCountChanged) {
        onRowCountChanged(data.length);
      }
    }, [data, onRowCountChanged]);

    if (!supportsAskUser) {
      return (
        <box>
          <text opacity={0.5}>Ask-user not available for this backend</text>
        </box>
      );
    }

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading pending questions...</text>
        </box>
      );
    }

    const questions = data ?? [];

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Decisions</text>
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          <text opacity={0.5}>
            {"  "}
            {`${questions.length} pending`}
          </text>
        </box>
        {questions.length === 0 ? (
          <EmptyState
            title="No pending decisions."
            hint="Questions from agents appear here. Press Enter to answer."
          />
        ) : (
          <Table
            columns={[...COLUMNS]}
            rows={questions as unknown as readonly Record<string, string>[]}
            cursor={cursor}
          />
        )}
      </box>
    );
  },
);
