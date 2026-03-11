/**
 * DAG view — ASCII tree of the contribution graph.
 *
 * Reuses the existing git-style DAG renderer from the CLI,
 * with color-coding by contribution kind and cursor navigation.
 */

import { Box, Text } from "ink";
import React, { useCallback, useEffect, useMemo } from "react";
import { contributionsToDagNodes, renderDag } from "../../cli/format-dag.js";
import type { Contribution } from "../../core/models.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { DagData, TuiDataProvider } from "../provider.js";

/** Props for the DAG view. */
export interface DagProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  /** Called when contributions are loaded, for cursor-based drill-down. */
  readonly onContributionsLoaded?: (contributions: readonly Contribution[]) => void;
}

/** Color map for contribution kinds. */
const KIND_COLORS: Record<string, string> = {
  work: "green",
  review: "yellow",
  discussion: "blue",
  adoption: "magenta",
  reproduction: "cyan",
};

/** DAG view component. */
export const DagView: React.NamedExoticComponent<DagProps> = React.memo(function DagView({
  provider,
  intervalMs,
  active,
  cursor,
  onContributionsLoaded,
}: DagProps): React.ReactElement {
  const fetcher = useCallback(() => provider.getDag(), [provider]);
  const { data, loading } = usePolledData<DagData>(fetcher, intervalMs, active);

  // Report loaded contributions for cursor-based drill-down
  useEffect(() => {
    if (data && onContributionsLoaded) {
      onContributionsLoaded(data.contributions);
    }
  }, [data, onContributionsLoaded]);

  const contributions = data?.contributions ?? [];

  // Build a CID→kind lookup for coloring
  const kindMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contributions) {
      map.set(c.cid, c.kind);
    }
    return map;
  }, [contributions]);

  // Render DAG lines
  const dagLines = useMemo(() => {
    if (contributions.length === 0) return [];
    const nodes = contributionsToDagNodes(contributions);
    return renderDag(nodes);
  }, [contributions]);

  // Build CID list for cursor mapping
  const cidList = useMemo(() => {
    return dagLines
      .filter((l) => l.label !== "")
      .map((l) => {
        // Extract CID from label: "blake3:abc123.. [kind] summary"
        const match = /^(blake3:\S+)/.exec(l.label);
        return match?.[1] ?? "";
      });
  }, [dagLines]);

  if (loading && !data) {
    return (
      <Box>
        <Text dimColor>Loading DAG...</Text>
      </Box>
    );
  }

  if (dagLines.length === 0) {
    return (
      <Box>
        <Text dimColor>(empty graph)</Text>
      </Box>
    );
  }

  // Track which display line index (node lines only) we're at
  let nodeIndex = 0;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold underline>
          Contribution DAG ({contributions.length} nodes)
        </Text>
        <Text dimColor>
          {"  "}
          <Text color="green">work</Text> <Text color="yellow">review</Text>{" "}
          <Text color="blue">discussion</Text> <Text color="magenta">adoption</Text>{" "}
          <Text color="cyan">reproduction</Text>
        </Text>
      </Box>
      {dagLines.map((line, i) => {
        const isNodeLine = line.label !== "";
        const currentNodeIndex = isNodeLine ? nodeIndex++ : -1;
        const isSelected = isNodeLine && currentNodeIndex === cursor;

        // Determine color from the CID in the label
        const cidInLabel = cidList[currentNodeIndex];
        const fullCid = contributions.find(
          (c) => cidInLabel && c.cid.includes(cidInLabel.replace("blake3:", "").replace("..", "")),
        )?.cid;
        const kind = fullCid ? kindMap.get(fullCid) : undefined;
        const color = kind ? KIND_COLORS[kind] : undefined;

        return (
          <Box key={`dag-${String(i)}`}>
            {isSelected ? (
              <Text color="cyan" bold>
                {">"}{" "}
              </Text>
            ) : (
              <Text> </Text>
            )}
            <Text dimColor>{line.graphPrefix}</Text>
            {isNodeLine &&
              (isSelected ? (
                <Text color="cyan"> {line.label}</Text>
              ) : color ? (
                <Text color={color}> {line.label}</Text>
              ) : (
                <Text> {line.label}</Text>
              ))}
          </Box>
        );
      })}
    </Box>
  );
});
