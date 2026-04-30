/**
 * `grove contribute` command — submit a contribution to the grove.
 *
 * Supports multiple ingestion modes (files, git diff, git tree, report)
 * and contribution kinds (work, review, discussion, adoption, reproduction).
 *
 * Delegates contribution creation to the shared operations layer
 * (contributeOperation) while handling CLI-specific concerns:
 * argument parsing, validation, store initialization, artifact ingestion,
 * contract loading, and output formatting.
 */

import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { ContributionMode } from "../../core/models.js";
import type { ContributeInput, OperationDeps } from "../../core/operations/index.js";
import { contributeOperation } from "../../core/operations/index.js";
import type { AgentOverrides } from "../agent.js";
import { outputJson, outputJsonError } from "../format.js";
import { findGroveDir, resolveGroveDir } from "../utils/grove-dir.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed and validated options for `grove contribute`. */
export interface ContributeOptions {
  readonly kind:
    | "work"
    | "review"
    | "discussion"
    | "adoption"
    | "reproduction"
    | "plan"
    | "ask_user"
    | "response";
  readonly mode: "evaluation" | "exploration" | undefined;
  readonly summary: string;
  readonly description?: string | undefined;

  // Ingestion mode (mutually exclusive)
  readonly artifacts: readonly string[];
  readonly fromGitDiff?: string | undefined;
  readonly fromGitTree: boolean;
  readonly fromReport?: string | undefined;

  // Relations
  readonly parent?: string | undefined;
  readonly reviews?: string | undefined;
  readonly respondsTo?: string | undefined;
  readonly adopts?: string | undefined;
  readonly reproduces?: string | undefined;

  // Metrics and scores
  readonly metric: readonly string[];
  readonly score: readonly string[];

  // Metadata
  readonly tags: readonly string[];

  // Idempotency
  readonly idempotencyKey?: string | undefined;

  // Agent
  readonly agentOverrides: AgentOverrides;

  // Output
  readonly json?: boolean | undefined;

  // Working directory
  readonly cwd: string;
  readonly groveOverride?: string | undefined;
}

/** Validation result — either valid or a list of errors. */
export type ValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly errors: readonly string[] };

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse `grove contribute` arguments.
 */
export function parseContributeArgs(args: readonly string[]): ContributeOptions {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      kind: { type: "string", default: "work" },
      mode: { type: "string" },
      summary: { type: "string" },
      description: { type: "string" },
      artifacts: { type: "string", multiple: true, default: [] },
      "from-git-diff": { type: "string" },
      "from-git-tree": { type: "boolean", default: false },
      "from-report": { type: "string" },
      parent: { type: "string" },
      reviews: { type: "string" },
      "responds-to": { type: "string" },
      adopts: { type: "string" },
      reproduces: { type: "string" },
      metric: { type: "string", multiple: true, default: [] },
      score: { type: "string", multiple: true, default: [] },
      tag: { type: "string", multiple: true, default: [] },
      "idempotency-key": { type: "string" },
      "agent-id": { type: "string" },
      "agent-name": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      platform: { type: "string" },
      role: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  return {
    kind: values.kind as ContributeOptions["kind"],
    mode: (values.mode as ContributeOptions["mode"]) ?? undefined,
    summary: values.summary as string,
    description: values.description as string | undefined,
    artifacts: values.artifacts as string[],
    fromGitDiff: values["from-git-diff"] as string | undefined,
    fromGitTree: values["from-git-tree"] as boolean,
    fromReport: values["from-report"] as string | undefined,
    parent: values.parent as string | undefined,
    reviews: values.reviews as string | undefined,
    respondsTo: values["responds-to"] as string | undefined,
    adopts: values.adopts as string | undefined,
    reproduces: values.reproduces as string | undefined,
    metric: values.metric as string[],
    score: values.score as string[],
    tags: values.tag as string[],
    idempotencyKey: values["idempotency-key"] as string | undefined,
    agentOverrides: {
      agentId: values["agent-id"] as string | undefined,
      agentName: values["agent-name"] as string | undefined,
      provider: values.provider as string | undefined,
      model: values.model as string | undefined,
      platform: values.platform as string | undefined,
      role: values.role as string | undefined,
    },
    json: values.json ?? false,
    cwd: process.cwd(),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_KINDS = [
  "work",
  "review",
  "discussion",
  "adoption",
  "reproduction",
  "plan",
  "ask_user",
  "response",
] as const;
const VALID_MODES = ["evaluation", "exploration"] as const;

/**
 * Parse a metric/score string in "name=value" format.
 *
 * Used by both validation and execution to avoid duplicated parsing logic.
 *
 * @returns Parsed result or an error message string.
 */
export function parseMetricString(
  raw: string,
  label: string,
): { readonly name: string; readonly value: number } | { readonly error: string } {
  const eqIdx = raw.indexOf("=");
  if (eqIdx <= 0) {
    return {
      error: `Invalid ${label} format '${raw}'. Expected 'name=value' (e.g., 'tests_passing=47')`,
    };
  }
  const name = raw.slice(0, eqIdx);
  const value = Number(raw.slice(eqIdx + 1));
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return { error: `Invalid ${label} value in '${raw}'. Value must be a finite number.` };
  }
  return { name, value };
}

/**
 * Validate contribute options. Checks:
 * - Required fields (summary)
 * - Valid kind and mode values
 * - Mutual exclusion of ingestion modes
 * - Kind/relation consistency
 * - Metric format (name=value)
 * - Score format (name=value)
 */
export function validateContributeOptions(options: ContributeOptions): ValidationResult {
  const errors: string[] = [];

  // Required fields
  if (!options.summary || options.summary.trim().length === 0) {
    errors.push("--summary is required and cannot be empty");
  }

  // Valid kind
  if (!VALID_KINDS.includes(options.kind as (typeof VALID_KINDS)[number])) {
    errors.push(`Invalid kind '${options.kind}'. Valid kinds: ${VALID_KINDS.join(", ")}`);
  }

  // Valid mode (undefined is allowed — resolved later from contract/default)
  if (
    options.mode !== undefined &&
    !VALID_MODES.includes(options.mode as (typeof VALID_MODES)[number])
  ) {
    errors.push(`Invalid mode '${options.mode}'. Valid modes: ${VALID_MODES.join(", ")}`);
  }

  // Mutual exclusion of ingestion modes
  const ingestionCount = [
    options.artifacts.length > 0,
    options.fromGitDiff !== undefined,
    options.fromGitTree,
    options.fromReport !== undefined,
  ].filter(Boolean).length;

  if (ingestionCount > 1) {
    errors.push(
      "Ingestion modes are mutually exclusive: use only one of --artifacts, --from-git-diff, --from-git-tree, --from-report",
    );
  }

  // Kind/relation consistency
  switch (options.kind) {
    case "review":
      if (!options.reviews) {
        errors.push("--kind review requires --reviews <cid>");
      }
      break;
    case "discussion":
      // Root discussions without --responds-to are valid (topic anchors).
      // Replies use --responds-to to build threads.
      break;
    case "adoption":
      if (!options.adopts) {
        errors.push("--kind adoption requires --adopts <cid>");
      }
      break;
    case "reproduction":
      if (!options.reproduces) {
        errors.push("--kind reproduction requires --reproduces <cid>");
      }
      break;
  }

  // Metric format: name=value
  for (const m of options.metric) {
    const result = parseMetricString(m, "metric");
    if ("error" in result) {
      errors.push(result.error);
    }
  }

  // Score format: name=value
  for (const s of options.score) {
    const result = parseMetricString(s, "score");
    if ("error" in result) {
      errors.push(result.error);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute `grove contribute`.
 *
 * 1. Validate options
 * 2. Find and open .grove/
 * 3. Load GROVE.md contract
 * 4. Validate artifact paths & ingest
 * 5. Build relations and scores
 * 6. Delegate to contributeOperation
 */
export async function executeContribute(options: ContributeOptions): Promise<{ cid: string }> {
  // 1. Validate
  const validation = validateContributeOptions(options);
  if (!validation.valid) {
    throw new Error(`Invalid contribute options:\n  ${validation.errors.join("\n  ")}`);
  }

  // Warn if --idempotency-key is set without a stable agent identity.
  // The default agentId is hostname-pid which changes on restart, making
  // cross-process idempotency silently ineffective.
  if (
    options.idempotencyKey !== undefined &&
    !options.agentOverrides.role &&
    !options.agentOverrides.agentId &&
    !process.env.GROVE_AGENT_ROLE &&
    !process.env.GROVE_AGENT_ID
  ) {
    process.stderr.write(
      "[grove] Warning: --idempotency-key without --role or --agent-id uses a process-scoped " +
        "identity (hostname-pid). Cross-process retries will not match. Set --role or --agent-id " +
        "for stable idempotency.\n",
    );
  }

  // 2. Find .grove/
  const { groveDir, dbPath } =
    options.groveOverride !== undefined
      ? resolveGroveDir(options.groveOverride)
      : (() => {
          const discovered = findGroveDir(options.cwd);
          if (discovered === undefined) {
            throw new Error(
              "No grove found. Run 'grove init' first to create a grove in this directory.",
            );
          }
          return { groveDir: discovered, dbPath: join(discovered, "grove.db") };
        })();
  const groveRoot = resolve(groveDir, "..");

  // Dynamic imports for lazy loading
  const { SqliteContributionStore, SqliteClaimStore, SqliteIdempotencyStore, initSqliteDb } =
    await import("../../local/sqlite-store.js");
  const { FsCas } = await import("../../local/fs-cas.js");
  const { DefaultFrontierCalculator } = await import("../../core/frontier.js");
  const { EnforcingContributionStore } = await import("../../core/enforcing-store.js");

  const casPath = join(groveDir, "cas");
  const db = initSqliteDb(dbPath);
  // Guarantee close() even when bootstrap (contract resolution, schema checks)
  // throws before we reach the main work. Without this, a bad GROVE.md or a
  // missing session row leaks the DB handle.
  try {
    const rawStore = new SqliteContributionStore(db);
    const claimStore = new SqliteClaimStore(db);
    const idempotencyStore = new SqliteIdempotencyStore(db);
    const cas = new FsCas(casPath);
    const frontier = new DefaultFrontierCalculator(rawStore);

    // 3. Load contract for enforcement, default mode, and metric directions.
    //    Shared bootstrap: session.config > GROVE.md > no enforcement.
    //    See src/cli/utils/resolve-contract.ts for the full precedence chain.
    const { SqliteGoalSessionStore } = await import("../../local/sqlite-goal-session-store.js");
    const { resolveContract } = await import("../utils/resolve-contract.js");
    const contract = await resolveContract({
      goalSessionStore: new SqliteGoalSessionStore(db),
      groveRoot,
      envSessionId: process.env.GROVE_SESSION_ID,
    });

    // Wrap store with enforcement if contract is available
    const store = contract ? new EnforcingContributionStore(rawStore, contract, { cas }) : rawStore;
    // 4. Validate parent CID exists (CLI-specific: early user-friendly error)
    if (options.parent) {
      const parent = await store.get(options.parent);
      if (!parent) {
        throw new Error(`Parent contribution not found: ${options.parent}`);
      }
    }

    // Validate relation target CIDs exist (CLI-specific: early user-friendly error)
    for (const cid of [options.reviews, options.respondsTo, options.adopts, options.reproduces]) {
      if (cid) {
        const target = await store.get(cid);
        if (!target) {
          throw new Error(`Relation target contribution not found: ${cid}`);
        }
      }
    }

    // 5. Validate artifact paths exist before ingesting (CLI-specific)
    for (const artifactPath of options.artifacts) {
      try {
        await access(artifactPath);
      } catch {
        throw new Error(`Artifact path not found: ${artifactPath}`);
      }
    }

    if (options.fromReport) {
      try {
        await access(options.fromReport);
      } catch {
        throw new Error(`Report file not found: ${options.fromReport}`);
      }
    }

    // 6. Ingest artifacts (CLI-specific: file/git/report ingestion)
    let artifacts: Record<string, string> = {};

    if (options.artifacts.length > 0) {
      const { ingestFiles } = await import("../../local/ingest/files.js");
      artifacts = await ingestFiles(cas, options.artifacts);
    } else if (options.fromGitDiff !== undefined) {
      const { ingestGitDiff } = await import("../../local/ingest/git-diff.js");
      artifacts = await ingestGitDiff(cas, options.fromGitDiff, options.cwd);
    } else if (options.fromGitTree) {
      const { ingestGitTree } = await import("../../local/ingest/git-tree.js");
      artifacts = await ingestGitTree(cas, options.cwd);
    } else if (options.fromReport !== undefined) {
      const { ingestReport } = await import("../../local/ingest/report.js");
      artifacts = await ingestReport(cas, options.fromReport);
    }

    // 7. Build relations
    const { RelationType } = await import("../../core/models.js");
    type RT = (typeof RelationType)[keyof typeof RelationType];
    const relations: Array<{ targetCid: string; relationType: RT }> = [];

    if (options.parent) {
      relations.push({
        targetCid: options.parent,
        relationType: RelationType.DerivesFrom,
      });
    }
    if (options.reviews) {
      relations.push({
        targetCid: options.reviews,
        relationType: RelationType.Reviews,
      });
    }
    if (options.respondsTo) {
      relations.push({
        targetCid: options.respondsTo,
        relationType: RelationType.RespondsTo,
      });
    }
    if (options.adopts) {
      relations.push({
        targetCid: options.adopts,
        relationType: RelationType.Adopts,
      });
    }
    if (options.reproduces) {
      relations.push({
        targetCid: options.reproduces,
        relationType: RelationType.Reproduces,
      });
    }

    // 8. Parse metrics into scores — use direction from GROVE.md contract when available
    const { ScoreDirection } = await import("../../core/models.js");
    type SD = (typeof ScoreDirection)[keyof typeof ScoreDirection];
    const scores: Record<string, { value: number; direction: SD }> | undefined =
      options.metric.length > 0 || options.score.length > 0 ? {} : undefined;

    for (const m of options.metric) {
      const parsed = parseMetricString(m, "metric");
      if ("error" in parsed) continue; // Already validated above
      const direction = contract?.metrics?.[parsed.name]?.direction ?? ScoreDirection.Maximize;
      if (scores) {
        scores[parsed.name] = { value: parsed.value, direction };
      }
    }

    for (const s of options.score) {
      const parsed = parseMetricString(s, "score");
      if ("error" in parsed) continue; // Already validated above
      const direction = contract?.metrics?.[parsed.name]?.direction ?? ScoreDirection.Maximize;
      if (scores) {
        scores[parsed.name] = { value: parsed.value, direction };
      }
    }

    // 9. Delegate to contributeOperation
    const opDeps: OperationDeps = {
      contributionStore: store,
      claimStore,
      cas,
      frontier,
      idempotencyStore,
      ...(contract !== undefined ? { contract } : {}),
    };

    const input: ContributeInput = {
      kind: options.kind,
      mode: options.mode as ContributionMode | undefined,
      summary: options.summary,
      ...(options.description !== undefined ? { description: options.description } : {}),
      artifacts,
      relations,
      ...(scores !== undefined ? { scores } : {}),
      tags: [...options.tags],
      agent: options.agentOverrides,
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    };

    const result = await contributeOperation(input, opDeps);

    if (!result.ok) {
      if (options.json) {
        outputJsonError(result.error);
        return { cid: "" };
      }
      throw new Error(result.error.message);
    }

    const value = result.value;

    if (options.json) {
      outputJson(value);
    } else {
      console.log(`Contribution ${value.cid}`);
      console.log(`  kind: ${value.kind}, mode: ${value.mode}`);
      console.log(`  artifacts: ${value.artifactCount}`);
      if (value.relationCount > 0) {
        console.log(`  relations: ${value.relationCount}`);
      }
    }

    return { cid: value.cid };
  } finally {
    db.close();
  }
}

/**
 * Handle the `grove contribute` CLI command.
 */
export async function handleContribute(
  args: readonly string[],
  groveOverride?: string,
): Promise<void> {
  const options = parseContributeArgs(args);
  await executeContribute({ ...options, groveOverride });
}
