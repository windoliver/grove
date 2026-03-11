/**
 * Contribution detail view — full manifest, relations, artifacts, thread.
 *
 * Pushed onto the navigation stack when Enter is pressed on a contribution.
 */

import { Box, Text } from "ink";
import React, { useCallback } from "react";
import { formatScore, formatTimestamp, truncateCid } from "../../shared/format.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { ContributionDetail, TuiDataProvider } from "../provider.js";

/** Props for the Detail view. */
export interface DetailProps {
  readonly provider: TuiDataProvider;
  readonly cid: string;
  readonly intervalMs: number;
}

/** Contribution detail view component. */
export const DetailView: React.NamedExoticComponent<DetailProps> = React.memo(function DetailView({
  provider,
  cid,
  intervalMs,
}: DetailProps): React.ReactElement {
  const fetcher = useCallback(() => provider.getContribution(cid), [provider, cid]);
  const { data, loading } = usePolledData<ContributionDetail | undefined>(
    fetcher,
    intervalMs,
    true,
  );

  if (loading && !data) {
    return (
      <Box>
        <Text dimColor>Loading {truncateCid(cid)}...</Text>
      </Box>
    );
  }

  if (!data) {
    return (
      <Box>
        <Text color="red">Contribution not found: {cid}</Text>
      </Box>
    );
  }

  const { contribution: c, ancestors, children, thread } = data;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {c.cid}
        </Text>
      </Box>

      {/* Metadata */}
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text bold>Kind:</Text> {c.kind}
          {"  "}
          <Text bold>Mode:</Text> {c.mode}
          {"  "}
          <Text bold>Created:</Text> {formatTimestamp(c.createdAt)}
        </Text>
        <Text>
          <Text bold>Agent:</Text> {c.agent.agentName ?? c.agent.agentId}
          {c.agent.model ? ` (${c.agent.model})` : ""}
          {c.agent.platform ? ` on ${c.agent.platform}` : ""}
        </Text>
        {c.tags.length > 0 && (
          <Text>
            <Text bold>Tags:</Text> {c.tags.join(", ")}
          </Text>
        )}
      </Box>

      {/* Summary and description */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold underline>
          Summary
        </Text>
        <Text>{c.summary}</Text>
        {c.description && (
          <Box marginTop={1}>
            <Text dimColor>{c.description.slice(0, 500)}</Text>
          </Box>
        )}
      </Box>

      {/* Scores */}
      {c.scores && Object.keys(c.scores).length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold underline>
            Scores
          </Text>
          {Object.entries(c.scores).map(([name, score]) => (
            <Text key={name}>
              {name}: {formatScore(score)} ({score.direction})
            </Text>
          ))}
        </Box>
      )}

      {/* Relations */}
      {c.relations.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold underline>
            Relations ({c.relations.length})
          </Text>
          {c.relations.map((r, i) => (
            <Text key={`rel-${String(i)}`}>
              {r.relationType} → {truncateCid(r.targetCid)}
            </Text>
          ))}
        </Box>
      )}

      {/* Artifacts */}
      {Object.keys(c.artifacts).length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold underline>
            Artifacts ({Object.keys(c.artifacts).length})
          </Text>
          {Object.entries(c.artifacts).map(([name, hash]) => (
            <Text key={name}>
              {name}: {truncateCid(hash)}
            </Text>
          ))}
        </Box>
      )}

      {/* Ancestors and children */}
      {ancestors.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold underline>
            Ancestors ({ancestors.length})
          </Text>
          {ancestors.map((a) => (
            <Text key={a.cid}>
              {truncateCid(a.cid)} [{a.kind}] {a.summary.slice(0, 50)}
            </Text>
          ))}
        </Box>
      )}

      {children.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold underline>
            Children ({children.length})
          </Text>
          {children.map((ch) => (
            <Text key={ch.cid}>
              {truncateCid(ch.cid)} [{ch.kind}] {ch.summary.slice(0, 50)}
            </Text>
          ))}
        </Box>
      )}

      {/* Discussion thread */}
      {thread.length > 1 && (
        <Box flexDirection="column">
          <Text bold underline>
            Discussion ({thread.length - 1} replies)
          </Text>
          {thread.slice(1).map((node) => (
            <Text key={node.contribution.cid}>
              {"  ".repeat(node.depth)}
              {truncateCid(node.contribution.cid)} {node.contribution.summary.slice(0, 40)} [
              {node.contribution.agent.agentName ?? node.contribution.agent.agentId}]{" "}
              {formatTimestamp(node.contribution.createdAt)}
            </Text>
          ))}
        </Box>
      )}

      {/* Context */}
      {c.context && Object.keys(c.context).length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold underline>
            Context
          </Text>
          <Text dimColor>{JSON.stringify(c.context, null, 2).slice(0, 300)}</Text>
        </Box>
      )}
    </Box>
  );
});
