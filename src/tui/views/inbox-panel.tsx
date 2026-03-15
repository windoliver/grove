/**
 * Inbox panel — agent-to-agent messages.
 *
 * Shows inbox messages if the provider exposes a TuiMessagingProvider-compatible
 * interface. Falls back to a "not available" message following the same pattern
 * as gossip-panel.tsx.
 */

import React, { useCallback, useEffect } from "react";
import { formatTimestamp } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { InboxMessage, TuiDataProvider, TuiMessagingProvider } from "../provider.js";

/** Props for the InboxPanel view. */
export interface InboxPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: ((count: number) => void) | undefined;
}

interface MessageRow {
  readonly cid: string;
  readonly from: string;
  readonly to: string;
  readonly message: string;
  readonly time: string;
}

const COLUMNS = [
  { header: "FROM", key: "from", width: 16 },
  { header: "TO", key: "to", width: 16 },
  { header: "MESSAGE", key: "message", width: 36 },
  { header: "TIME", key: "time", width: 12 },
] as const;

/** Check if a provider exposes a getInboxMessages method. */
function hasMessaging(
  provider: TuiDataProvider,
): provider is TuiDataProvider & TuiMessagingProvider {
  return (
    "getInboxMessages" in provider &&
    typeof (provider as unknown as TuiMessagingProvider).getInboxMessages === "function"
  );
}

/** Inbox panel showing agent-to-agent messages. */
export const InboxPanelView: React.NamedExoticComponent<InboxPanelProps> = React.memo(
  function InboxPanelView({
    provider,
    intervalMs,
    active,
    cursor,
    onRowCountChanged,
  }: InboxPanelProps): React.ReactNode {
    const supportsMessaging = hasMessaging(provider);

    const fetcher = useCallback(async (): Promise<readonly MessageRow[]> => {
      if (!supportsMessaging) return [];

      const messages: readonly InboxMessage[] = await (
        provider as unknown as TuiMessagingProvider
      ).getInboxMessages({ limit: 30 });
      return messages.map((m) => ({
        cid: m.cid,
        from:
          (m.from.agentName ?? m.from.agentId).length > 16
            ? `${(m.from.agentName ?? m.from.agentId).slice(0, 14)}..`
            : (m.from.agentName ?? m.from.agentId),
        to:
          m.recipients.join(", ").length > 16
            ? `${m.recipients.join(", ").slice(0, 14)}..`
            : m.recipients.join(", "),
        message: m.body.length > 36 ? `${m.body.slice(0, 34)}..` : m.body,
        time: formatTimestamp(m.createdAt),
      }));
    }, [provider, supportsMessaging]);

    const { data, loading, isStale, error } = usePolledData<readonly MessageRow[]>(
      fetcher,
      intervalMs,
      active,
    );

    useEffect(() => {
      if (data && onRowCountChanged) {
        onRowCountChanged(data.length);
      }
    }, [data, onRowCountChanged]);

    if (!supportsMessaging) {
      return (
        <box>
          <text opacity={0.5}>Messaging not available for this backend</text>
        </box>
      );
    }

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading inbox messages...</text>
        </box>
      );
    }

    const messages = data ?? [];

    return (
      <box flexDirection="column">
        <box marginBottom={1}>
          <text>Inbox</text>
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          <text opacity={0.5}>
            {"  "}
            {messages.length} messages
          </text>
        </box>
        {messages.length === 0 ? (
          <box>
            <text opacity={0.5}>No inbox messages</text>
          </box>
        ) : (
          <Table
            columns={[...COLUMNS]}
            rows={messages as unknown as readonly Record<string, string>[]}
            cursor={cursor}
          />
        )}
      </box>
    );
  },
);
