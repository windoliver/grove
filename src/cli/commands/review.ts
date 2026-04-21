/**
 * grove review — submit a review of an existing contribution.
 *
 * Usage:
 *   grove review blake3:abc123 --summary "Looks good"
 *   grove review blake3:abc123 --summary "Quality check" --score quality=0.8
 *   grove review blake3:abc123 --summary "Needs work" --score quality=0.3 --json
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { EnforcingContributionStore } from "../../core/enforcing-store.js";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import type { Score } from "../../core/models.js";
import { ScoreDirection } from "../../core/models.js";
import type { OperationDeps } from "../../core/operations/deps.js";
import { reviewOperation } from "../../core/operations/index.js";
import { FsCas } from "../../local/fs-cas.js";
import { createSqliteStores } from "../../local/sqlite-store.js";
import { resolveAgent } from "../agent.js";
import { outputJson, outputJsonError } from "../format.js";
import { resolveGroveDir } from "../utils/grove-dir.js";
import { resolveContract } from "../utils/resolve-contract.js";

export interface ReviewOptions {
  readonly targetCid: string;
  readonly summary: string;
  readonly description?: string | undefined;
  /**
   * Raw parsed scores as name→value. Direction is deferred to `runReview`
   * so we can honor the GROVE.md contract's metric direction when available,
   * rather than blindly defaulting to maximize.
   */
  readonly scores: Readonly<Record<string, number>>;
  readonly tags: readonly string[];
  readonly json: boolean;
}

/**
 * Parse `grove review` arguments.
 *
 * Positional: <target-cid>
 * Flags: --summary, --description, --score name=value, --tag, --json
 */
export function parseReviewArgs(args: readonly string[]): ReviewOptions {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      summary: { type: "string" },
      description: { type: "string" },
      score: { type: "string", multiple: true, default: [] },
      tag: { type: "string", multiple: true, default: [] },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const targetCid = positionals[0];
  if (!targetCid) {
    throw new Error(
      "Usage: grove review <target-cid> --summary <text> [--score name=value] [--json]\n" +
        '  grove review blake3:abc.. --summary "Looks good" --score quality=0.8',
    );
  }

  const summary = values.summary as string | undefined;
  if (!summary) {
    throw new Error("--summary is required for grove review");
  }

  // Parse scores from "name=value" format. Direction is resolved later
  // against the contract (see runReview) so a metric configured as
  // `minimize` in GROVE.md is not silently recorded as maximize.
  const scores: Record<string, number> = {};
  for (const s of values.score as string[]) {
    const eq = s.indexOf("=");
    if (eq === -1) {
      throw new Error(`Invalid score format: '${s}'. Expected name=value (e.g., quality=0.8)`);
    }
    const name = s.slice(0, eq);
    const value = Number.parseFloat(s.slice(eq + 1));
    if (Number.isNaN(value)) {
      throw new Error(`Invalid score value for '${name}': not a number`);
    }
    scores[name] = value;
  }

  return {
    targetCid,
    summary,
    ...(values.description !== undefined ? { description: values.description as string } : {}),
    scores,
    tags: values.tag as string[],
    json: values.json as boolean,
  };
}

/** Execute `grove review` using the operations layer. */
export async function runReview(options: ReviewOptions, groveOverride?: string): Promise<void> {
  const { dbPath, groveDir } = resolveGroveDir(groveOverride);
  const stores = createSqliteStores(dbPath);
  const cas = new FsCas(join(groveDir, "cas"));
  const frontier = new DefaultFrontierCalculator(stores.contributionStore);

  try {
    // Resolve the contract so reviews go through the same enforcement
    // pipeline as contribute/discuss/inbox. Without this, GROVE.md rate
    // limits and role-kind rules silently don't apply to reviews.
    const contract = await resolveContract({
      goalSessionStore: stores.goalSessionStore,
      groveRoot: join(groveDir, ".."),
      envSessionId: process.env.GROVE_SESSION_ID,
    });

    const contributionStore = contract
      ? new EnforcingContributionStore(stores.contributionStore, contract, { cas })
      : stores.contributionStore;

    const agent = resolveAgent();
    const opDeps: OperationDeps = {
      contributionStore,
      claimStore: stores.claimStore,
      cas,
      frontier,
      ...(contract !== undefined ? { contract } : {}),
    };

    // Resolve score directions from the contract (defaults to maximize
    // when unknown) so minimize-metrics aren't inverted.
    const resolvedScores: Record<string, Score> = {};
    for (const [name, value] of Object.entries(options.scores)) {
      const direction = contract?.metrics?.[name]?.direction ?? ScoreDirection.Maximize;
      resolvedScores[name] = { value, direction };
    }

    const result = await reviewOperation(
      {
        targetCid: options.targetCid,
        summary: options.summary,
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(Object.keys(resolvedScores).length > 0 ? { scores: resolvedScores } : {}),
        ...(options.tags.length > 0 ? { tags: options.tags } : {}),
        agent: { agentId: agent.agentId },
      },
      opDeps,
    );

    if (!result.ok) {
      if (options.json) {
        outputJsonError(result.error);
        return;
      }
      console.error(`grove review: ${result.error.message}`);
      process.exitCode = 1;
      return;
    }

    if (options.json) {
      outputJson(result.value);
    } else {
      console.log(`Review submitted: ${result.value.cid}`);
      console.log(`  Target: ${result.value.targetCid}`);
      console.log(`  Summary: ${result.value.summary}`);
    }
  } finally {
    stores.close();
  }
}

/** Handle the `grove review` CLI command. */
export async function handleReview(args: readonly string[], groveOverride?: string): Promise<void> {
  const options = parseReviewArgs(args);
  await runReview(options, groveOverride);
}
