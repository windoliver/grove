/**
 * grove reproduce — submit a reproduction attempt of an existing contribution.
 *
 * Usage:
 *   grove reproduce blake3:abc123 --summary "Confirmed results"
 *   grove reproduce blake3:abc123 --summary "Different results" --result challenged
 *   grove reproduce blake3:abc123 --summary "Partial" --result partial --json
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { EnforcingContributionStore } from "../../core/enforcing-store.js";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import type { Score } from "../../core/models.js";
import { ScoreDirection } from "../../core/models.js";
import type { OperationDeps } from "../../core/operations/deps.js";
import { reproduceOperation } from "../../core/operations/index.js";
import { FsCas } from "../../local/fs-cas.js";
import { createSqliteStores } from "../../local/sqlite-store.js";
import { resolveAgent } from "../agent.js";
import { outputJson, outputJsonError } from "../format.js";
import { resolveGroveDir } from "../utils/grove-dir.js";
import { resolveContract } from "../utils/resolve-contract.js";

export interface ReproduceOptions {
  readonly targetCid: string;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly result: "confirmed" | "challenged" | "partial";
  /**
   * Raw parsed scores as name→value. Direction is deferred to `runReproduce`
   * so we can honor the GROVE.md contract's metric direction when available.
   */
  readonly scores: Readonly<Record<string, number>>;
  readonly tags: readonly string[];
  readonly json: boolean;
}

/**
 * Parse `grove reproduce` arguments.
 *
 * Positional: <target-cid>
 * Flags: --summary, --description, --result, --score name=value, --tag, --json
 */
export function parseReproduceArgs(args: readonly string[]): ReproduceOptions {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      summary: { type: "string" },
      description: { type: "string" },
      result: { type: "string", default: "confirmed" },
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
      "Usage: grove reproduce <target-cid> --summary <text> [--result confirmed|challenged|partial] [--json]\n" +
        '  grove reproduce blake3:abc.. --summary "Confirmed results"',
    );
  }

  const summary = values.summary as string | undefined;
  if (!summary) {
    throw new Error("--summary is required for grove reproduce");
  }

  const resultValue = values.result as string;
  if (resultValue !== "confirmed" && resultValue !== "challenged" && resultValue !== "partial") {
    throw new Error(
      `Invalid --result '${resultValue}'. Valid values: confirmed, challenged, partial`,
    );
  }

  // Parse scores from "name=value" format. Direction is resolved later
  // against the contract (see runReproduce) so a metric configured as
  // `minimize` in GROVE.md is not silently recorded as maximize.
  const scores: Record<string, number> = {};
  for (const s of values.score as string[]) {
    const eq = s.indexOf("=");
    if (eq === -1) {
      throw new Error(`Invalid score format: '${s}'. Expected name=value (e.g., accuracy=0.95)`);
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
    result: resultValue,
    scores,
    tags: values.tag as string[],
    json: values.json as boolean,
  };
}

/** Execute `grove reproduce` using the operations layer. */
export async function runReproduce(
  options: ReproduceOptions,
  groveOverride?: string,
): Promise<void> {
  const { dbPath, groveDir } = resolveGroveDir(groveOverride);
  const stores = createSqliteStores(dbPath);
  const cas = new FsCas(join(groveDir, "cas"));
  const frontier = new DefaultFrontierCalculator(stores.contributionStore);

  try {
    // Resolve the contract so reproductions go through the same enforcement
    // pipeline as contribute/discuss/review/inbox.
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

    const result = await reproduceOperation(
      {
        targetCid: options.targetCid,
        summary: options.summary,
        ...(options.description !== undefined ? { description: options.description } : {}),
        result: options.result,
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
      console.error(`grove reproduce: ${result.error.message}`);
      process.exitCode = 1;
      return;
    }

    if (options.json) {
      outputJson(result.value);
    } else {
      console.log(`Reproduction submitted: ${result.value.cid}`);
      console.log(`  Target: ${result.value.targetCid}`);
      console.log(`  Result: ${result.value.result}`);
      console.log(`  Summary: ${result.value.summary}`);
    }
  } finally {
    stores.close();
  }
}

/** Handle the `grove reproduce` CLI command. */
export async function handleReproduce(
  args: readonly string[],
  groveOverride?: string,
): Promise<void> {
  const options = parseReproduceArgs(args);
  await runReproduce(options, groveOverride);
}
