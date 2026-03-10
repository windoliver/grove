/**
 * grove release — release or complete a claim.
 *
 * Usage:
 *   grove release <claim-id>
 *   grove release <claim-id> --completed
 */

import { parseArgs } from "node:util";

import type { ClaimStore } from "../../core/store.js";
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

  if (values.completed) {
    const claim = await deps.claimStore.complete(claimId);
    deps.stdout(formatClaimSummary(claim, "Completed"));
  } else {
    const claim = await deps.claimStore.release(claimId);
    deps.stdout(formatClaimSummary(claim, "Released"));
  }
}
