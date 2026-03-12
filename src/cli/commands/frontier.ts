/**
 * grove frontier — show current frontier rankings.
 *
 * Usage:
 *   grove frontier                              # show all dimensions
 *   grove frontier --metric throughput          # best by specific metric
 *   grove frontier --tag H100                   # filtered by tag
 *   grove frontier --mode exploration           # exploration contributions only
 *   grove frontier --json
 */

import { parseArgs } from "node:util";
import type { ContributionMode, JsonValue } from "../../core/models.js";
import type { FrontierEntrySummary, FrontierInput } from "../../core/operations/index.js";
import { frontierOperation } from "../../core/operations/index.js";
import type { CliDeps, Writer } from "../context.js";
import { formatTable } from "../format.js";
import { toOperationDeps } from "../operation-adapter.js";

const DEFAULT_LIMIT = 10;

export interface FrontierOptions {
  readonly metric?: string | undefined;
  readonly tag?: string | undefined;
  readonly mode?: string | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly limit: number;
  readonly json: boolean;
}

export function parseFrontierArgs(argv: string[]): FrontierOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      metric: { type: "string" },
      tag: { type: "string" },
      mode: { type: "string" },
      context: { type: "string" },
      n: { type: "string", short: "n" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const limit = values.n !== undefined ? Number.parseInt(values.n, 10) : DEFAULT_LIMIT;
  if (Number.isNaN(limit) || limit <= 0) {
    throw new Error(`Invalid limit: '${values.n}'. Must be a positive integer.`);
  }

  let context: Record<string, JsonValue> | undefined;
  if (values.context !== undefined) {
    try {
      context = JSON.parse(values.context) as Record<string, JsonValue>;
    } catch {
      throw new Error(
        `Invalid --context: must be valid JSON object. Example: --context '{"hardware":"H100"}'`,
      );
    }
    if (typeof context !== "object" || context === null || Array.isArray(context)) {
      throw new Error(`Invalid --context: must be a JSON object, not an array or primitive.`);
    }
  }

  return {
    metric: values.metric,
    tag: values.tag,
    mode: values.mode,
    context,
    limit,
    json: values.json ?? false,
  };
}

export async function runFrontier(
  options: FrontierOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  const input: FrontierInput = {
    ...(options.metric !== undefined ? { metric: options.metric } : {}),
    ...(options.tag !== undefined ? { tags: [options.tag] } : {}),
    ...(options.mode !== undefined ? { mode: options.mode as ContributionMode } : {}),
    ...(options.context !== undefined ? { context: options.context } : {}),
    limit: options.limit,
  };

  const result = await frontierOperation(input, toOperationDeps(deps));

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  const frontier = result.value;

  if (options.json) {
    writer(JSON.stringify(frontier, null, 2));
    return;
  }

  const sections: string[] = [];

  // Metric sections
  for (const [metricName, entries] of Object.entries(frontier.byMetric)) {
    const section = formatFrontierSummarySection(`By metric: ${metricName}`, entries);
    if (section) sections.push(section);
  }

  // Other dimensions
  const otherSections: readonly [string, readonly FrontierEntrySummary[]][] = [
    ["By adoption count", frontier.byAdoption],
    ["By recency", frontier.byRecency],
    ["By review score", frontier.byReviewScore],
    ["By reproduction count", frontier.byReproduction],
  ];

  for (const [heading, entries] of otherSections) {
    const section = formatFrontierSummarySection(heading, entries);
    if (section) sections.push(section);
  }

  if (sections.length === 0) {
    writer("(no frontier data)");
    return;
  }

  writer(sections.join("\n\n"));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Standard columns for frontier display from operation summaries. */
const FRONTIER_COLUMNS = [
  { header: "CID", key: "cid", maxWidth: 22 },
  { header: "SUMMARY", key: "summary", maxWidth: 40 },
  { header: "VALUE", key: "value", align: "right" as const, maxWidth: 14 },
  { header: "AGENT", key: "agent", maxWidth: 16 },
] as const;

function summaryToRow(entry: FrontierEntrySummary): Record<string, string> {
  const cid = entry.cid;
  const short = cid.length > 20 ? `${cid.slice(0, 18)}..` : cid;
  return {
    cid: short,
    summary: entry.summary,
    value: entry.value.toFixed(2),
    agent: entry.agentId,
  };
}

/** Format frontier entry summaries as a table with a heading. */
function formatFrontierSummarySection(
  heading: string,
  entries: readonly FrontierEntrySummary[],
): string {
  if (entries.length === 0) return "";
  const table = formatTable(FRONTIER_COLUMNS, entries.map(summaryToRow));
  return `${heading}\n${table}`;
}
