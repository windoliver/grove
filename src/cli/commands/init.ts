/**
 * `grove init` command — create a new grove.
 *
 * Creates the .grove/ directory with SQLite store and CAS,
 * generates a default GROVE.md contract, and optionally ingests seed artifacts.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import type { AgentOverrides } from "../agent.js";
import { resolveAgent } from "../agent.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Parsed options for `grove init`. */
export interface InitOptions {
  readonly name: string;
  readonly mode: "evaluation" | "exploration";
  readonly seed: readonly string[];
  readonly metric: readonly string[];
  readonly description?: string | undefined;
  readonly force: boolean;
  readonly agentOverrides: AgentOverrides;
  readonly cwd: string;
}

/**
 * Parse `grove init` arguments.
 *
 * Usage: grove init [name] [--seed <path>...] [--mode <mode>] [--metric <name:direction>...]
 *        [--description <text>] [--force]
 */
export function parseInitArgs(args: readonly string[]): InitOptions {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      seed: { type: "string", multiple: true, default: [] },
      mode: { type: "string", default: "evaluation" },
      metric: { type: "string", multiple: true, default: [] },
      description: { type: "string" },
      force: { type: "boolean", default: false },
      "agent-id": { type: "string" },
      "agent-name": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      platform: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const mode = values.mode as string;
  if (mode !== "evaluation" && mode !== "exploration") {
    throw new Error(`Invalid mode '${mode}'. Valid modes: evaluation, exploration`);
  }

  // Validate metric format: name:direction
  for (const m of values.metric as string[]) {
    const parts = m.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid metric format '${m}'. Expected 'name:direction' (e.g., 'val_bpb:minimize')`,
      );
    }
    const direction = parts[1];
    if (direction !== "minimize" && direction !== "maximize") {
      throw new Error(
        `Invalid metric direction '${direction}' in '${m}'. Valid directions: minimize, maximize`,
      );
    }
  }

  const name = positionals[0] ?? basename(process.cwd());

  return {
    name,
    mode: mode as "evaluation" | "exploration",
    seed: values.seed as string[],
    metric: values.metric as string[],
    description: values.description as string | undefined,
    force: values.force as boolean,
    agentOverrides: {
      agentId: values["agent-id"] as string | undefined,
      agentName: values["agent-name"] as string | undefined,
      provider: values.provider as string | undefined,
      model: values.model as string | undefined,
      platform: values.platform as string | undefined,
    },
    cwd: process.cwd(),
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Dependencies for executeInit (injectable for testing). */
export interface InitDeps {
  readonly cwd: string;
}

/**
 * Execute `grove init`.
 *
 * 1. Check for existing .grove/ (error unless --force)
 * 2. Validate seed paths exist
 * 3. Create .grove/ directory structure
 * 4. Initialize SQLite store
 * 5. Generate GROVE.md
 * 6. Optionally ingest seed artifacts and create root contribution
 */
export async function executeInit(options: InitOptions): Promise<{ grovePath: string }> {
  const grovePath = join(options.cwd, ".grove");

  // 1. Check for existing grove
  if (!options.force) {
    const exists = await dirExists(grovePath);
    if (exists) {
      throw new Error(`Grove already initialized at ${grovePath}. Use --force to reinitialize.`);
    }
  }

  // 2. Validate seed paths before creating any state
  for (const seedPath of options.seed) {
    try {
      await access(seedPath);
    } catch {
      throw new Error(`Seed path not found: ${seedPath}`);
    }
  }

  // 3. Create directory structure
  const casPath = join(grovePath, "cas");
  const workspacesPath = join(grovePath, "workspaces");
  await mkdir(casPath, { recursive: true });
  await mkdir(workspacesPath, { recursive: true });

  // 4. Initialize SQLite store
  const dbPath = join(grovePath, "store.sqlite");
  const { initSqliteDb } = await import("../../local/sqlite-store.js");
  const db = initSqliteDb(dbPath);

  // 5. Generate GROVE.md
  const grovemdPath = join(options.cwd, "GROVE.md");
  const grovemdContent = generateGroveMd(options);
  await writeFile(grovemdPath, grovemdContent, "utf-8");

  // 6. Ingest seed artifacts if provided
  if (options.seed.length > 0) {
    const { FsCas } = await import("../../local/fs-cas.js");
    const { ingestFiles } = await import("../../local/ingest/files.js");
    const { createContribution } = await import("../../core/manifest.js");
    const { SqliteContributionStore } = await import("../../local/sqlite-store.js");

    const cas = new FsCas(casPath);
    const store = new SqliteContributionStore(db);
    const agent = resolveAgent(options.agentOverrides);

    const artifacts = await ingestFiles(cas, options.seed);

    if (Object.keys(artifacts).length > 0) {
      const contribution = createContribution({
        kind: "work",
        mode: options.mode,
        summary: `Seed artifacts for ${options.name}`,
        artifacts,
        relations: [],
        tags: ["seed"],
        agent,
        createdAt: new Date().toISOString(),
      });

      await store.put(contribution);
      console.log(`Seeded ${Object.keys(artifacts).length} artifact(s) as ${contribution.cid}`);
    }
  }

  db.close();

  console.log(`Initialized grove '${options.name}' at ${grovePath}`);
  return { grovePath };
}

// ---------------------------------------------------------------------------
// GROVE.md template generation
// ---------------------------------------------------------------------------

function generateGroveMd(options: InitOptions): string {
  const metricLines = generateMetricLines(options.metric);
  const description = options.description ?? `Grove for ${options.name}`;

  return `---
contract_version: 2
name: ${options.name}
description: ${description}
mode: ${options.mode}
${metricLines}
# Gates — contribution acceptance rules.
# Uncomment and configure to enforce quality requirements.
#
# gates:
#   - type: metric_improves
#     metric: <metric_name>       # Contribution must improve this metric
#   - type: has_artifact
#     name: <artifact_name>       # Contribution must include this artifact
#   - type: has_relation
#     relation_type: derives_from # Contribution must have this relation
#   - type: min_reviews
#     count: 1                    # Minimum review count before acceptance
#   - type: min_score
#     metric: <metric_name>
#     threshold: 0.95             # Minimum score threshold

# Stop conditions — when to pause work.
# Uncomment and configure to control agent behavior.
#
# stop_conditions:
#   max_rounds_without_improvement: 5
#   target_metric:
#     metric: <metric_name>
#     value: 0.99
#   budget:
#     max_contributions: 100
#     max_wall_clock_seconds: 3600
#   quorum_review_score:
#     min_reviews: 3
#     min_score: 8
#   deliberation_limit:
#     max_rounds: 10
#     max_messages: 50

# Concurrency — control parallel work.
#
# concurrency:
#   max_active_claims: 10
#   max_claims_per_agent: 2

# Execution — lease and heartbeat settings.
#
# execution:
#   default_lease_seconds: 300
#   max_lease_seconds: 1800
#   heartbeat_interval_seconds: 60
#   stall_timeout_seconds: 120

# Rate limits — prevent runaway agents.
#
# rate_limits:
#   max_contributions_per_agent_per_hour: 30
#   max_contributions_per_grove_per_hour: 100
#   max_artifact_size_bytes: 10485760
#   max_artifacts_per_contribution: 50

# Retry — backoff configuration for failed operations.
#
# retry:
#   max_attempts: 5
#   base_delay_ms: 10000
#   max_backoff_ms: 300000

# Lifecycle hooks — shell commands run at key points.
# Uncomment and configure as needed.
#
# hooks:
#   after_checkout: "echo 'Workspace ready'"
#   before_contribute: "bun test"
#   after_contribute: "echo 'Contribution submitted'"
---

# ${options.name}

${description}
`;
}

function generateMetricLines(metrics: readonly string[]): string {
  if (metrics.length === 0) {
    return `# Metrics — define measurable objectives.
# Uncomment and configure for evaluation mode.
#
# metrics:
#   metric_name:
#     direction: minimize    # or maximize
#     unit: ""               # optional unit label
#     description: ""        # optional description`;
  }

  const lines = ["metrics:"];
  for (const m of metrics) {
    const [name, direction] = m.split(":");
    lines.push(`  ${name}:`);
    lines.push(`    direction: ${direction}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle the `grove init` CLI command.
 */
export async function handleInit(args: readonly string[]): Promise<void> {
  const options = parseInitArgs(args);
  await executeInit(options);
}
