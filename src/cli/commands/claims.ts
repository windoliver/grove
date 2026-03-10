/**
 * grove claims — list claims.
 *
 * Usage:
 *   grove claims                    # all active claims
 *   grove claims --agent agent-bob  # claims by specific agent
 *   grove claims --expired          # show expired claims
 */

import { parseArgs } from "node:util";

import { ClaimStatus } from "../../core/models.js";
import type { ClaimQuery, ClaimStore } from "../../core/store.js";
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

  const query: ClaimQuery = {};
  const mutableQuery = query as { status?: string | readonly string[]; agentId?: string };

  if (values.expired) {
    mutableQuery.status = [ClaimStatus.Expired, ClaimStatus.Released, ClaimStatus.Completed];
  } else {
    mutableQuery.status = ClaimStatus.Active;
  }

  if (values.agent) {
    mutableQuery.agentId = values.agent;
  }

  const claims = await deps.claimStore.listClaims(query);
  deps.stdout(formatClaimsTable(claims));
}
