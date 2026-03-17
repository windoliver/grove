/**
 * VFS browser view — browse Nexus zone VFS tree.
 *
 * Only available when provider supports TuiVfsProvider (capabilities.vfs).
 * Shows a directory listing with navigation.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { FsEntry, TuiDataProvider, TuiVfsProvider } from "../provider.js";
import { theme } from "../theme.js";

/** Props for the VFS browser view. */
export interface VfsBrowserProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  /** Incremented by parent when Enter is pressed; triggers navigation into directories. */
  readonly navigateTrigger?: number | undefined;
}

const COLUMNS = [
  { header: "NAME", key: "name", width: 32 },
  { header: "TYPE", key: "type", width: 10 },
  { header: "SIZE", key: "size", width: 12 },
] as const;

/** Check if provider supports VFS. */
function isVfsProvider(provider: TuiDataProvider): provider is TuiDataProvider & TuiVfsProvider {
  return provider.capabilities.vfs && "listPath" in provider;
}

/** Format bytes to human-readable. */
function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** VFS browser view component. */
export const VfsBrowserView: React.NamedExoticComponent<VfsBrowserProps> = React.memo(
  function VfsBrowserView({
    provider,
    intervalMs,
    active,
    cursor,
    navigateTrigger,
  }: VfsBrowserProps): React.ReactNode {
    const [currentPath, setCurrentPath] = useState("/");
    const prevTriggerRef = useRef(navigateTrigger ?? 0);

    const fetcher = useCallback(async () => {
      if (!isVfsProvider(provider)) return [] as readonly FsEntry[];
      return provider.listPath(currentPath);
    }, [provider, currentPath]);

    const { data: entries, loading } = usePolledData<readonly FsEntry[]>(
      fetcher,
      intervalMs,
      active && isVfsProvider(provider),
    );

    // Build display rows: prepend ".." when not at root
    const isRoot = currentPath === "/";
    const allEntries: readonly FsEntry[] = isRoot
      ? (entries ?? [])
      : [{ name: "..", type: "directory" as const }, ...(entries ?? [])];

    // Navigate when parent increments navigateTrigger
    useEffect(() => {
      const trigger = navigateTrigger ?? 0;
      if (trigger === prevTriggerRef.current) return;
      prevTriggerRef.current = trigger;

      const entry = allEntries[cursor];
      if (!entry || entry.type !== "directory") return;

      if (entry.name === "..") {
        // Go up: remove trailing slash, then last segment
        const trimmed = currentPath.replace(/\/$/, "");
        const parentPath = trimmed.substring(0, trimmed.lastIndexOf("/") + 1) || "/";
        setCurrentPath(parentPath);
      } else {
        setCurrentPath(`${currentPath}${entry.name}/`);
      }
    }, [navigateTrigger, cursor, allEntries, currentPath]);

    if (!isVfsProvider(provider)) {
      return (
        <box>
          <text opacity={0.5}>
            VFS requires Nexus backend (configure via GROVE_NEXUS_URL, grove.json, or --nexus)
          </text>
        </box>
      );
    }

    if (loading && !entries) {
      return (
        <box>
          <text opacity={0.5}>Loading VFS...</text>
        </box>
      );
    }

    const rows = allEntries.map((entry) => ({
      name: entry.type === "directory" ? `${entry.name}/` : entry.name,
      type: entry.type,
      size: formatSize(entry.sizeBytes),
    }));

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="column">
          <box flexDirection="row">
            <text color={theme.muted}>{"Path: "}</text>
            {currentPath === "/" ? (
              <text bold>/</text>
            ) : (
              <>
                <text color={theme.muted}>
                  {`${currentPath.replace(/\/$/, "").split("/").slice(0, -1).join("/")}/`}
                </text>
                <text bold>{currentPath.replace(/\/$/, "").split("/").pop()}</text>
              </>
            )}
          </box>
          {rows.length > 0 ? <text color={theme.dimmed}>Enter:browse Esc:back</text> : null}
        </box>
        {rows.length === 0 ? (
          <EmptyState
            title="Nexus virtual filesystem."
            hint="j/k to navigate, Enter to browse, Esc to go back."
          />
        ) : (
          <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
        )}
      </box>
    );
  },
);
