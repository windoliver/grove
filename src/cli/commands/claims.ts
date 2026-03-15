/**
 * grove claims — list claims.
 *
 * Usage:
 *   grove claims                    # all active claims
 *   grove claims --agent agent-bob  # claims by specific agent
 *   grove claims --expired          # show expired claims
 *   grove claims --json             # JSON output
 */

import { parseArgs } from "node:util";

import type { Claim } from "../../core/models.js";
import { ClaimStatus } from "../../core/models.js";
import type { OperationDeps } from "../../core/operations/index.js";
import { listClaimsOperation } from "../../core/operations/index.js";
import type { ClaimStore } from "../../core/store.js";
import { outputJson, outputJsonError } from "../format.js";
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
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const json = values.json ?? false;

  if (values.expired) {
    // Terminal claims: use listClaimsOperation with status filter
    const opDeps: OperationDeps = {
      claimStore: deps.claimStore,
    };

    const result = await listClaimsOperation(
      {
        status: [ClaimStatus.Expired, ClaimStatus.Released, ClaimStatus.Completed],
        agentId: values.agent,
      },
      opDeps,
    );

    if (!result.ok) {
      if (json) {
        outputJsonError(result.error);
        return;
      }
      throw new Error(result.error.message);
    }

    if (json) {
      outputJson(result.value);
      return;
    }

    // Fetch full Claim objects for table formatting (operation returns summaries)
    const claims = await deps.claimStore.listClaims({
      status: [ClaimStatus.Expired, ClaimStatus.Released, ClaimStatus.Completed],
      agentId: values.agent,
    });
    deps.stdout(formatClaimsTable(claims));
  } else {
    // Active claims: use activeClaims() which applies lease cutoff,
    // then filter by agent in-memory (active set is always small)
    let claims: readonly Claim[] = await deps.claimStore.activeClaims();
    if (values.agent) {
      const agentId = values.agent;
      claims = claims.filter((c) => c.agent.agentId === agentId);
    }

    if (json) {
      outputJson({
        claims: claims.map((c) => ({
          claimId: c.claimId,
          targetRef: c.targetRef,
          status: c.status,
          agentId: c.agent.agentId,
          intentSummary: c.intentSummary,
          leaseExpiresAt: c.leaseExpiresAt,
          createdAt: c.createdAt,
        })),
        count: claims.length,
      });
      return;
    }

    deps.stdout(formatClaimsTable(claims));
  }
}
