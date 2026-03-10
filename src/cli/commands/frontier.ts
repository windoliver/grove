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
import type { FrontierEntry, FrontierQuery } from "../../core/frontier.js";
import type { ContributionMode, JsonValue } from "../../core/models.js";
import type { CliDeps, Writer } from "../context.js";
import { formatFrontierSection } from "../format.js";

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
  const query: FrontierQuery = {
    metric: options.metric,
    tags: options.tag !== undefined ? [options.tag] : undefined,
    mode: options.mode as ContributionMode | undefined,
    context: options.context,
    limit: options.limit,
  };

  const frontier = await deps.frontier.compute(query);

  if (options.json) {
    writer(JSON.stringify(frontier, null, 2));
    return;
  }

  const sections: string[] = [];

  // Metric sections
  for (const [metricName, entries] of Object.entries(frontier.byMetric)) {
    const section = formatFrontierSection(`By metric: ${metricName}`, entries);
    if (section) sections.push(section);
  }

  // Other dimensions
  const otherSections: readonly [string, readonly FrontierEntry[]][] = [
    ["By adoption count", frontier.byAdoption],
    ["By recency", frontier.byRecency],
    ["By review score", frontier.byReviewScore],
    ["By reproduction count", frontier.byReproduction],
  ];

  for (const [heading, entries] of otherSections) {
    const section = formatFrontierSection(heading, entries);
    if (section) sections.push(section);
  }

  if (sections.length === 0) {
    writer("(no frontier data)");
    return;
  }

  writer(sections.join("\n\n"));
}
