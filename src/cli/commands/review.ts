/**
 * grove review — submit a review of an existing contribution.
 *
 * Usage:
 *   grove review blake3:abc123 --summary "Looks good"
 *   grove review blake3:abc123 --summary "Quality check" --score quality=0.8
 *   grove review blake3:abc123 --summary "Needs work" --score quality=0.3 --json
 */

import { parseArgs } from "node:util";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import type { Score } from "../../core/models.js";
import type { OperationDeps } from "../../core/operations/deps.js";
import { reviewOperation } from "../../core/operations/index.js";
import { FsCas } from "../../local/fs-cas.js";
import { createSqliteStores } from "../../local/sqlite-store.js";
import { resolveAgent } from "../agent.js";
import { outputJson, outputJsonError } from "../format.js";
import { resolveGroveDir } from "../utils/grove-dir.js";

export interface ReviewOptions {
  readonly targetCid: string;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly scores: Readonly<Record<string, Score>>;
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

  // Parse scores from "name=value" format
  const scores: Record<string, Score> = {};
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
    scores[name] = { value, direction: "maximize" };
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
  const cas = new FsCas(`${groveDir}/cas`);
  const frontier = new DefaultFrontierCalculator(stores.contributionStore);

  try {
    const agent = resolveAgent();
    const opDeps: OperationDeps = {
      contributionStore: stores.contributionStore,
      claimStore: stores.claimStore,
      cas,
      frontier,
    };

    const result = await reviewOperation(
      {
        targetCid: options.targetCid,
        summary: options.summary,
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(Object.keys(options.scores).length > 0 ? { scores: options.scores } : {}),
        ...(options.tags.length > 0 ? { tags: options.tags } : {}),
        agent: { agentId: agent.agentId },
      },
      opDeps,
    );

    if (!result.ok) {
      if (options.json) {
        outputJsonError(result.error);
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
