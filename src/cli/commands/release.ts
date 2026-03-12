/**
 * grove release — release or complete a claim.
 *
 * Usage:
 *   grove release <claim-id>
 *   grove release <claim-id> --completed
 */

import { parseArgs } from "node:util";
import type { OperationDeps } from "../../core/operations/index.js";
import { releaseOperation } from "../../core/operations/index.js";
import type { ClaimStore } from "../../core/store.js";
import { outputJson, outputJsonError } from "../format.js";
import { formatClaimSummary } from "../utils/output.js";

export interface ReleaseDeps {
  readonly claimStore: ClaimStore;
  readonly stdout: (msg: string) => void;
  readonly stderr: (msg: string) => void;
}

export async function runRelease(args: readonly string[], deps: ReleaseDeps): Promise<void> {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      completed: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const claimId = positionals[0];
  if (!claimId) {
    deps.stderr("Error: claim-id is required.\n\nUsage: grove release <claim-id> [--completed]");
    process.exitCode = 2;
    return;
  }

  const action = values.completed ? "complete" : "release";

  // Build minimal OperationDeps with only what releaseOperation needs
  const opDeps: OperationDeps = {
    claimStore: deps.claimStore,
    contributionStore: undefined as never,
    cas: undefined as never,
    frontier: undefined as never,
  };

  const result = await releaseOperation({ claimId, action }, opDeps);

  if (!result.ok) {
    if (values.json) {
      outputJsonError(result.error);
    }
    throw new Error(result.error.message);
  }

  if (values.json) {
    outputJson(result.value);
    return;
  }

  // Fetch the updated claim for formatting
  const claim = await deps.claimStore.getClaim(result.value.claimId);
  if (claim === undefined) {
    deps.stdout(
      `${action === "complete" ? "Completed" : "Released"}: ${result.value.claimId}\n` +
        `  target: ${result.value.targetRef}\n` +
        `  status: ${result.value.status}`,
    );
    return;
  }

  deps.stdout(formatClaimSummary(claim, action === "complete" ? "Completed" : "Released"));
}
