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
import { outputJson } from "../format.js";
import { handleOperationError } from "../utils/handle-result.js";
import { formatClaimSummary } from "../utils/output.js";
import { requirePositional } from "../utils/parse-helpers.js";

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

  const claimId = requirePositional(positionals, 0, "claim-id");

  const action = values.completed ? "complete" : "release";

  // Build minimal OperationDeps with only what releaseOperation needs
  const opDeps: OperationDeps = {
    claimStore: deps.claimStore,
  };

  const result = await releaseOperation({ claimId, action }, opDeps);

  if (!result.ok) {
    handleOperationError(result.error, values.json);
    return;
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
