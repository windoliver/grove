/**
 * grove eval — run the contract's eval harness against a target contribution
 * and report structured metric scores.
 *
 * Usage:
 *   grove eval <cid>                       # cmd from GROVE.md hooks.eval
 *   grove eval --frontier <metric>         # eval the frontier leader for <metric>
 *   grove eval --latest                    # eval the most recent contribution
 *   grove eval <cid> --eval-command "..."  # override the eval command
 *   grove eval <cid> --submit              # eval, then submit a scored reproduction
 *   grove eval <cid> --timeout 600000      # subprocess timeout (ms)
 *   grove eval <cid> --json
 *
 * The eval command is spawned via `sh -c` with GROVE_TARGET_CID set to the
 * resolved target. It must print score lines in the form
 *   GROVE_SCORE <metric>=<value>
 * to stdout or stderr (other output is ignored).
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { EnforcingContributionStore } from "../../core/enforcing-store.js";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import type { Score } from "../../core/models.js";
import { ScoreDirection } from "../../core/models.js";
import type { AgentOverrides } from "../../core/operations/agent.js";
import type { OperationDeps } from "../../core/operations/deps.js";
import type { EvalScore } from "../../core/operations/index.js";
import {
  evalOperation,
  frontierOperation,
  logOperation,
  reproduceOperation,
} from "../../core/operations/index.js";
import { FsCas } from "../../local/fs-cas.js";
import { createSqliteStores } from "../../local/sqlite-store.js";
import { resolveAgent } from "../agent.js";
import type { Writer } from "../context.js";
import { outputJson, outputJsonError } from "../format.js";
import { resolveGroveDir } from "../utils/grove-dir.js";
import { resolveContract } from "../utils/resolve-contract.js";

export interface EvalOptions {
  /** Positional target CID. Mutually exclusive with --frontier / --latest. */
  readonly targetCid?: string | undefined;
  /** Resolve the target as the frontier leader for this metric. */
  readonly frontierMetric?: string | undefined;
  /** Resolve the target as the most recent contribution. */
  readonly latest: boolean;
  /** Override the eval command (otherwise resolved from contract.hooks.eval). */
  readonly evalCommand?: string | undefined;
  /** Submit a scored reproduction contribution after a successful eval. */
  readonly submit: boolean;
  /** Summary for the reproduction created by --submit. */
  readonly summary?: string | undefined;
  /** Subprocess timeout in milliseconds. */
  readonly timeoutMs?: number | undefined;
  readonly json: boolean;
}

/**
 * Parse `grove eval` arguments.
 *
 * Positional: <cid> (optional — alternative to --frontier / --latest)
 * Flags: --frontier, --latest, --eval-command, --submit, --summary, --timeout, --json
 */
export function parseEvalArgs(args: readonly string[]): EvalOptions {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      frontier: { type: "string" },
      latest: { type: "boolean", default: false },
      "eval-command": { type: "string" },
      submit: { type: "boolean", default: false },
      summary: { type: "string" },
      timeout: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const targetCid = positionals[0];
  const frontierMetric = values.frontier as string | undefined;
  const latest = values.latest as boolean;

  // Exactly one target selector must be supplied.
  const selectorCount = (targetCid ? 1 : 0) + (frontierMetric ? 1 : 0) + (latest ? 1 : 0);
  if (selectorCount === 0) {
    throw new Error(
      "Usage: grove eval <cid> | --frontier <metric> | --latest [--eval-command <cmd>] [--submit] [--json]",
    );
  }
  if (selectorCount > 1) {
    throw new Error("Specify exactly one target: <cid>, --frontier <metric>, or --latest");
  }

  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = Number.parseInt(values.timeout as string, 10);
    if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid --timeout '${values.timeout}': expected a positive integer (ms)`);
    }
  }

  return {
    ...(targetCid !== undefined ? { targetCid } : {}),
    ...(frontierMetric !== undefined ? { frontierMetric } : {}),
    latest,
    ...(values["eval-command"] !== undefined
      ? { evalCommand: values["eval-command"] as string }
      : {}),
    submit: values.submit as boolean,
    ...(values.summary !== undefined ? { summary: values.summary as string } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    json: values.json as boolean,
  };
}

/** Resolve the target CID from the option selectors. */
async function resolveTargetCid(options: EvalOptions, deps: OperationDeps): Promise<string> {
  if (options.targetCid) return options.targetCid;

  if (options.frontierMetric) {
    const result = await frontierOperation({ metric: options.frontierMetric, limit: 1 }, deps);
    if (!result.ok) throw new Error(result.error.message);
    const leader = result.value.byMetric[options.frontierMetric]?.[0];
    if (!leader) {
      throw new Error(`No frontier leader found for metric '${options.frontierMetric}'`);
    }
    return leader.cid;
  }

  // --latest
  const result = await logOperation({ limit: 1 }, deps);
  if (!result.ok) throw new Error(result.error.message);
  const latest = result.value.results[0];
  if (!latest) throw new Error("No contributions found to evaluate");
  return latest.cid;
}

/** Build a default reproduction summary from the parsed scores. */
function defaultSummary(targetCid: string, scores: readonly EvalScore[]): string {
  const parts = scores.map((s) => `${s.metric}=${s.value}`).join(", ");
  return parts ? `Eval of ${targetCid}: ${parts}` : `Eval of ${targetCid}`;
}

/** Execute `grove eval` against injected operation dependencies. */
export async function runEval(
  options: EvalOptions,
  deps: OperationDeps,
  agent: AgentOverrides,
  writer: Writer = console.log,
): Promise<void> {
  const targetCid = await resolveTargetCid(options, deps);

  const result = await evalOperation(deps, {
    targetCid,
    ...(options.evalCommand !== undefined ? { evalCommand: options.evalCommand } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  if (!result.ok) {
    if (options.json) {
      outputJsonError(result.error);
      return;
    }
    throw new Error(result.error.message);
  }

  const evalResult = result.value;

  // --submit: record a scored reproduction (only when the eval succeeded).
  let reproductionCid: string | undefined;
  if (options.submit) {
    if (evalResult.exitCode !== 0) {
      if (!options.json) {
        writer(`eval exited ${evalResult.exitCode}; skipping --submit`);
      }
    } else {
      const scores: Record<string, Score> = {};
      for (const s of evalResult.scores) {
        const direction = deps.contract?.metrics?.[s.metric]?.direction ?? ScoreDirection.Maximize;
        scores[s.metric] = { value: s.value, direction };
      }
      const repro = await reproduceOperation(
        {
          targetCid,
          summary: options.summary ?? defaultSummary(targetCid, evalResult.scores),
          result: "confirmed",
          ...(Object.keys(scores).length > 0 ? { scores } : {}),
          agent,
        },
        deps,
      );
      if (!repro.ok) {
        if (options.json) {
          outputJsonError(repro.error);
          return;
        }
        throw new Error(repro.error.message);
      }
      reproductionCid = repro.value.cid;
    }
  }

  if (options.json) {
    outputJson({ targetCid, ...evalResult, ...(reproductionCid ? { reproductionCid } : {}) });
    return;
  }

  writer(`Eval target: ${targetCid}`);
  if (evalResult.scores.length === 0) {
    writer("  (no scores parsed)");
  } else {
    for (const s of evalResult.scores) {
      writer(`  ${s.metric} = ${s.value}`);
    }
  }
  writer(`exit code: ${evalResult.exitCode}${evalResult.timedOut ? " (timed out)" : ""}`);
  if (reproductionCid) {
    writer(`Reproduction submitted: ${reproductionCid}`);
  }
}

/** Handle the `grove eval` CLI command. */
export async function handleEval(args: readonly string[], groveOverride?: string): Promise<void> {
  const options = parseEvalArgs(args);
  const { dbPath, groveDir } = resolveGroveDir(groveOverride);
  const stores = createSqliteStores(dbPath);
  const cas = new FsCas(join(groveDir, "cas"));
  const frontier = new DefaultFrontierCalculator(stores.contributionStore);

  try {
    const contract = await resolveContract({
      goalSessionStore: stores.goalSessionStore,
      groveRoot: join(groveDir, ".."),
      envSessionId: process.env.GROVE_SESSION_ID,
    });

    const contributionStore = contract
      ? new EnforcingContributionStore(stores.contributionStore, contract, { cas })
      : stores.contributionStore;

    const agent = resolveAgent();
    const deps: OperationDeps = {
      contributionStore,
      claimStore: stores.claimStore,
      cas,
      frontier,
      ...(contract !== undefined ? { contract } : {}),
    };

    await runEval(options, deps, { agentId: agent.agentId });
  } finally {
    stores.close();
  }
}
