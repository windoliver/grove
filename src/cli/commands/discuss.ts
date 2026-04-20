/**
 * grove discuss — shorthand for posting discussions and replies.
 *
 * Usage:
 *   grove discuss "Should we use polling or push?"           # root discussion
 *   grove discuss blake3:abc123 "I think push is better"    # reply to thread
 *   grove discuss blake3:abc123 "Push wins" --tag arch      # reply with tags
 *   grove discuss "New topic" --tag design --mode exploration
 *   grove discuss "Topic" --json
 */

import { join } from "node:path";
import { parseArgs } from "node:util";

import type { ContributionMode } from "../../core/models.js";
import { RelationType } from "../../core/models.js";
import type { OperationDeps } from "../../core/operations/index.js";
import { contributeOperation } from "../../core/operations/index.js";
import { resolveAgent } from "../agent.js";
import { outputJson } from "../format.js";
import { resolveGroveDir } from "../utils/grove-dir.js";

export interface DiscussOptions {
  readonly respondsTo?: string | undefined;
  readonly message: string;
  readonly tags: readonly string[];
  readonly mode?: "evaluation" | "exploration" | undefined;
  readonly description?: string | undefined;
  readonly json?: boolean | undefined;
  readonly groveOverride?: string | undefined;
}

/**
 * Parse `grove discuss` arguments.
 *
 * Positional args: [cid] <message>
 *   - If one positional: it's the message (root discussion)
 *   - If two positionals: first is CID, second is message (reply)
 * Flags: --tag, --mode, --description, --json
 */
export function parseDiscussArgs(args: readonly string[]): DiscussOptions {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      tag: { type: "string", multiple: true, default: [] },
      mode: { type: "string" },
      description: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length === 0) {
    throw new Error(
      "Usage: grove discuss [<cid>] <message>\n" +
        '  grove discuss "Topic question"                  # root discussion\n' +
        '  grove discuss blake3:abc.. "Reply message"      # reply to thread',
    );
  }

  let respondsTo: string | undefined;
  let message: string;

  // First positional is a CID when it looks like "<algo>:<hex>" — a single
  // token with a hash prefix and only hex chars after the colon. Previously
  // this was `startsWith("blake3:")` which mis-parsed sentences that happened
  // to begin with the literal prefix and couldn't tolerate other hash algos.
  // We stay permissive on the digest length so CLI shorthand still works.
  const first = positionals[0];
  if (first !== undefined && /^[a-z][a-z0-9]*:[0-9a-f]+$/i.test(first)) {
    // Reply mode: first positional is the CID, rest is the message.
    respondsTo = first;
    message = positionals.slice(1).join(" ");
  } else {
    // Root discussion — all positionals form the message.
    message = positionals.join(" ");
  }

  if (message.trim().length === 0) {
    throw new Error("Discussion message cannot be empty.");
  }

  const mode = values.mode as DiscussOptions["mode"];
  if (mode !== undefined && mode !== "evaluation" && mode !== "exploration") {
    throw new Error(`Invalid mode '${mode}'. Valid modes: evaluation, exploration`);
  }

  return {
    respondsTo,
    message,
    tags: values.tag as string[],
    mode,
    description: values.description as string | undefined,
    json: values.json ?? false,
  };
}

/**
 * Execute `grove discuss` by initializing the store and calling discussOperation.
 */
export async function executeDiscuss(options: DiscussOptions): Promise<{ cid: string }> {
  const { groveDir, dbPath } = resolveGroveDir(options.groveOverride);

  // Dynamic imports for lazy loading
  const { createSqliteStores } = await import("../../local/sqlite-store.js");
  const { FsCas } = await import("../../local/fs-cas.js");
  const { DefaultFrontierCalculator } = await import("../../core/frontier.js");
  const { EnforcingContributionStore } = await import("../../core/enforcing-store.js");
  const { resolveContract } = await import("../utils/resolve-contract.js");

  const stores = createSqliteStores(dbPath);
  const cas = new FsCas(join(groveDir, "cas"));
  const frontier = new DefaultFrontierCalculator(stores.contributionStore);

  // Shared bootstrap: session.config > GROVE.md > no enforcement.
  // See src/cli/utils/resolve-contract.ts for the full precedence chain.
  const contract = await resolveContract({
    goalSessionStore: stores.goalSessionStore,
    groveRoot: join(groveDir, ".."),
    envSessionId: process.env.GROVE_SESSION_ID,
  });

  // Wrap store with enforcement if contract is available
  const store = contract
    ? new EnforcingContributionStore(stores.contributionStore, contract, { cas })
    : stores.contributionStore;

  try {
    const opDeps: OperationDeps = {
      contributionStore: store,
      claimStore: stores.claimStore,
      cas,
      frontier,
      ...(contract !== undefined ? { contract } : {}),
    };

    // Build relations
    const relations =
      options.respondsTo !== undefined
        ? [{ targetCid: options.respondsTo, relationType: RelationType.RespondsTo }]
        : [];

    // Explicitly pass the resolved agent identity so discussions are
    // attributed consistently with contribute/review/reproduce/inbox (all of
    // which pass `agent` rather than relying on operation-layer fallback).
    const agent = resolveAgent();

    const result = await contributeOperation(
      {
        kind: "discussion",
        mode: options.mode as ContributionMode | undefined,
        summary: options.message,
        description: options.description,
        relations,
        tags: [...options.tags],
        agent: {
          agentId: agent.agentId,
          ...(agent.agentName ? { agentName: agent.agentName } : {}),
        },
      },
      opDeps,
    );

    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const value = result.value;

    if (options.json) {
      outputJson(value);
    } else {
      console.log(`Contribution ${value.cid}`);
      console.log(`  kind: ${value.kind}`);
      if (options.respondsTo) {
        console.log(`  responds-to: ${options.respondsTo}`);
      }
    }

    return { cid: value.cid };
  } finally {
    stores.close();
  }
}

/** Handle the `grove discuss` CLI command. */
export async function handleDiscuss(
  args: readonly string[],
  groveOverride?: string,
): Promise<void> {
  const options = parseDiscussArgs(args);
  await executeDiscuss({ ...options, groveOverride });
}
