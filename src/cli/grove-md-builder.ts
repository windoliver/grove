/**
 * Composable GROVE.md template builder.
 *
 * Replaces the monolithic string template in init.ts with per-section
 * render functions that can be independently composed by presets.
 */

import type { AgentTopology } from "../core/topology.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Per-section configuration for building a GROVE.md contract. */
export interface GroveMdConfig {
  readonly contractVersion: 2 | 3;
  readonly name: string;
  readonly description?: string | undefined;
  readonly mode: "evaluation" | "exploration";
  readonly metrics?: readonly MetricEntry[] | undefined;
  readonly gates?: readonly GateEntry[] | undefined;
  readonly stopConditions?: StopConditionsConfig | undefined;
  readonly concurrency?: ConcurrencyConfig | undefined;
  readonly execution?: ExecutionConfig | undefined;
  readonly rateLimits?: RateLimitsConfig | undefined;
  readonly retry?: RetryConfig | undefined;
  readonly hooks?: HooksConfig | undefined;
  readonly topology?: AgentTopology | undefined;
  readonly body?: string | undefined;
}

export interface MetricEntry {
  readonly name: string;
  readonly direction: "minimize" | "maximize";
  readonly unit?: string | undefined;
  readonly description?: string | undefined;
}

export interface GateEntry {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface StopConditionsConfig {
  readonly maxRoundsWithoutImprovement?: number | undefined;
  readonly targetMetric?: { metric: string; value: number } | undefined;
  readonly budget?: { maxContributions?: number; maxWallClockSeconds?: number } | undefined;
}

export interface ConcurrencyConfig {
  readonly maxActiveClaims?: number | undefined;
  readonly maxClaimsPerAgent?: number | undefined;
}

export interface ExecutionConfig {
  readonly defaultLeaseSeconds?: number | undefined;
  readonly maxLeaseSeconds?: number | undefined;
  readonly heartbeatIntervalSeconds?: number | undefined;
  readonly stallTimeoutSeconds?: number | undefined;
}

export interface RateLimitsConfig {
  readonly maxContributionsPerAgentPerHour?: number | undefined;
  readonly maxContributionsPerGrovePerHour?: number | undefined;
}

export interface RetryConfig {
  readonly maxAttempts?: number | undefined;
  readonly baseDelayMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
}

export interface HooksConfig {
  readonly afterCheckout?: string | undefined;
  readonly beforeContribute?: string | undefined;
  readonly afterContribute?: string | undefined;
}

// ---------------------------------------------------------------------------
// Per-section renderers
// ---------------------------------------------------------------------------

function renderMetrics(metrics: readonly MetricEntry[] | undefined): string {
  if (!metrics || metrics.length === 0) {
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
    lines.push(`  ${m.name}:`);
    lines.push(`    direction: ${m.direction}`);
    if (m.unit) lines.push(`    unit: "${m.unit}"`);
    if (m.description) lines.push(`    description: "${m.description}"`);
  }
  return lines.join("\n");
}

function renderGates(gates: readonly GateEntry[] | undefined): string {
  if (!gates || gates.length === 0) {
    return `# Gates — contribution acceptance rules.
# Uncomment and configure to enforce quality requirements.
#
# gates:
#   - type: metric_improves
#     metric: <metric_name>
#   - type: has_artifact
#     name: <artifact_name>
#   - type: has_relation
#     relation_type: derives_from
#   - type: min_reviews
#     count: 1`;
  }

  const lines = ["gates:"];
  for (const gate of gates) {
    const entries = Object.entries(gate);
    const entry = entries[0];
    if (!entry) continue;
    const [firstKey, firstVal] = entry;
    lines.push(`  - ${firstKey}: ${formatYamlValue(firstVal)}`);
    for (const [k, v] of entries.slice(1)) {
      lines.push(`    ${k}: ${formatYamlValue(v)}`);
    }
  }
  return lines.join("\n");
}

function renderStopConditions(sc: StopConditionsConfig | undefined): string {
  if (!sc) {
    return `# Stop conditions — when to pause work.
#
# stop_conditions:
#   max_rounds_without_improvement: 5
#   target_metric:
#     metric: <metric_name>
#     value: 0.99
#   budget:
#     max_contributions: 100
#     max_wall_clock_seconds: 3600`;
  }

  const lines = ["stop_conditions:"];
  if (sc.maxRoundsWithoutImprovement !== undefined) {
    lines.push(`  max_rounds_without_improvement: ${sc.maxRoundsWithoutImprovement}`);
  }
  if (sc.targetMetric) {
    lines.push(`  target_metric:`);
    lines.push(`    metric: ${sc.targetMetric.metric}`);
    lines.push(`    value: ${sc.targetMetric.value}`);
  }
  if (sc.budget) {
    lines.push(`  budget:`);
    if (sc.budget.maxContributions !== undefined) {
      lines.push(`    max_contributions: ${sc.budget.maxContributions}`);
    }
    if (sc.budget.maxWallClockSeconds !== undefined) {
      lines.push(`    max_wall_clock_seconds: ${sc.budget.maxWallClockSeconds}`);
    }
  }
  return lines.join("\n");
}

function renderConcurrency(c: ConcurrencyConfig | undefined): string {
  if (!c) {
    return `# Concurrency — control parallel work.
#
# concurrency:
#   max_active_claims: 10
#   max_claims_per_agent: 2`;
  }

  const lines = ["concurrency:"];
  if (c.maxActiveClaims !== undefined) lines.push(`  max_active_claims: ${c.maxActiveClaims}`);
  if (c.maxClaimsPerAgent !== undefined)
    lines.push(`  max_claims_per_agent: ${c.maxClaimsPerAgent}`);
  return lines.join("\n");
}

function renderExecution(e: ExecutionConfig | undefined): string {
  if (!e) {
    return `# Execution — lease and heartbeat settings.
#
# execution:
#   default_lease_seconds: 300
#   max_lease_seconds: 1800
#   heartbeat_interval_seconds: 60
#   stall_timeout_seconds: 120`;
  }

  const lines = ["execution:"];
  if (e.defaultLeaseSeconds !== undefined)
    lines.push(`  default_lease_seconds: ${e.defaultLeaseSeconds}`);
  if (e.maxLeaseSeconds !== undefined) lines.push(`  max_lease_seconds: ${e.maxLeaseSeconds}`);
  if (e.heartbeatIntervalSeconds !== undefined)
    lines.push(`  heartbeat_interval_seconds: ${e.heartbeatIntervalSeconds}`);
  if (e.stallTimeoutSeconds !== undefined)
    lines.push(`  stall_timeout_seconds: ${e.stallTimeoutSeconds}`);
  return lines.join("\n");
}

function renderTopology(topology: AgentTopology | undefined, version: 2 | 3): string {
  if (!topology || version < 3) return "";

  const lines = ["agent_topology:"];
  lines.push(`  structure: ${topology.structure}`);
  lines.push("  roles:");
  for (const role of topology.roles) {
    lines.push(`    - name: ${role.name}`);
    if (role.description) lines.push(`      description: "${role.description}"`);
    if (role.prompt) {
      if (role.prompt.includes("\n")) {
        // Multiline prompt — use YAML block scalar
        lines.push("      prompt: |");
        for (const line of role.prompt.split("\n")) {
          lines.push(`        ${line}`);
        }
      } else {
        lines.push(`      prompt: "${role.prompt}"`);
      }
    }
    if (role.maxInstances !== undefined) lines.push(`      max_instances: ${role.maxInstances}`);
    if (role.platform) lines.push(`      platform: ${role.platform}`);
    if (role.command) lines.push(`      command: "${role.command}"`);
    if (role.edges && role.edges.length > 0) {
      lines.push("      edges:");
      for (const edge of role.edges) {
        lines.push(`        - target: ${edge.target}`);
        lines.push(`          edge_type: ${edge.edgeType}`);
      }
    }
  }
  if (topology.spawning) {
    lines.push("  spawning:");
    lines.push(`    dynamic: ${topology.spawning.dynamic}`);
    if (topology.spawning.maxDepth !== undefined)
      lines.push(`    max_depth: ${topology.spawning.maxDepth}`);
    if (topology.spawning.maxChildrenPerAgent !== undefined)
      lines.push(`    max_children_per_agent: ${topology.spawning.maxChildrenPerAgent}`);
  }
  return lines.join("\n");
}

function renderHooks(hooks: HooksConfig | undefined): string {
  if (!hooks) {
    return `# Lifecycle hooks — shell commands run at key points.
#
# hooks:
#   after_checkout: "echo 'Workspace ready'"
#   before_contribute: "bun test"
#   after_contribute: "echo 'Contribution submitted'"`;
  }

  const lines = ["hooks:"];
  if (hooks.afterCheckout) lines.push(`  after_checkout: "${hooks.afterCheckout}"`);
  if (hooks.beforeContribute) lines.push(`  before_contribute: "${hooks.beforeContribute}"`);
  if (hooks.afterContribute) lines.push(`  after_contribute: "${hooks.afterContribute}"`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build a complete GROVE.md file from config sections.
 */
export function buildGroveMd(config: GroveMdConfig): string {
  const description = config.description ?? `Grove for ${config.name}`;

  const sections: string[] = [];

  // Required frontmatter header
  sections.push(`contract_version: ${config.contractVersion}`);
  sections.push(`name: ${config.name}`);
  sections.push(`description: ${description}`);
  sections.push(`mode: ${config.mode}`);

  // Optional active sections
  sections.push(renderMetrics(config.metrics));
  sections.push(renderGates(config.gates));
  sections.push(renderStopConditions(config.stopConditions));
  sections.push(renderConcurrency(config.concurrency));
  sections.push(renderExecution(config.execution));

  // Topology (V3 only)
  const topologySection = renderTopology(config.topology, config.contractVersion);
  if (topologySection) sections.push(topologySection);

  // Rate limits (always commented template)
  sections.push(`# Rate limits — prevent runaway agents.
#
# rate_limits:
#   max_contributions_per_agent_per_hour: 30
#   max_contributions_per_grove_per_hour: 100
#   max_artifact_size_bytes: 10485760
#   max_artifacts_per_contribution: 50`);

  // Retry (always commented template)
  sections.push(`# Retry — backoff configuration for failed operations.
#
# retry:
#   max_attempts: 5
#   base_delay_ms: 10000
#   max_backoff_ms: 300000`);

  sections.push(renderHooks(config.hooks));

  const body = config.body ?? `# ${config.name}\n\n${description}`;

  return `---\n${sections.join("\n\n")}\n---\n\n${body}\n`;
}

/**
 * Create a default GroveMdConfig from init options (backward compatible).
 */
export function defaultGroveMdConfig(options: {
  name: string;
  mode: "evaluation" | "exploration";
  description?: string | undefined;
  metric?: readonly string[] | undefined;
}): GroveMdConfig {
  const metrics: MetricEntry[] = (options.metric ?? []).map((m) => {
    const [name, direction] = m.split(":");
    return { name: name ?? m, direction: direction as "minimize" | "maximize" };
  });

  return {
    contractVersion: 2,
    name: options.name,
    description: options.description,
    mode: options.mode,
    metrics: metrics.length > 0 ? metrics : undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatYamlValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
