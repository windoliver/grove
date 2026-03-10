/**
 * grove claims — list claims.
 *
 * Usage:
 *   grove claims                    # all active claims
 *   grove claims --agent agent-bob  # claims by specific agent
 *   grove claims --expired          # show expired claims
 */

import { parseArgs } from "node:util";

import type { Claim } from "../../core/models.js";
import { ClaimStatus } from "../../core/models.js";
import type { ClaimStore } from "../../core/store.js";
import { formatClaimsTable } from "../utils/output.js";

export interface ClaimsDeps {
  readonly claimStore: ClaimStore;
  readonly stdout: (msg: string) => void;
  readonly stderr: (msg: string) => void;
}

export async function runClaims(args: readonly string[], deps: ClaimsDeps): Promise<void> {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      agent: { type: "string", short: "a" },
      expired: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  let claims: readonly Claim[];

  if (values.expired) {
    // Terminal claims: use listClaims with status filter
    claims = await deps.claimStore.listClaims({
      status: [ClaimStatus.Expired, ClaimStatus.Released, ClaimStatus.Completed],
      agentId: values.agent,
    });
  } else {
    // Active claims: use activeClaims() which applies lease cutoff,
    // then filter by agent in-memory (active set is always small)
    claims = await deps.claimStore.activeClaims();
    if (values.agent) {
      const agentId = values.agent;
      claims = claims.filter((c) => c.agent.agentId === agentId);
    }
  }

  deps.stdout(formatClaimsTable(claims));
}
