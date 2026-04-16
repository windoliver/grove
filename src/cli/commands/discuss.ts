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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { ContributionMode } from "../../core/models.js";
import { RelationType } from "../../core/models.js";
import type { OperationDeps } from "../../core/operations/index.js";
import { contributeOperation } from "../../core/operations/index.js";
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

  if (positionals[0]?.startsWith("blake3:")) {
    // First positional is a CID — reply mode. Rest is the message.
    respondsTo = positionals[0];
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
  const { parseGroveContract } = await import("../../core/contract.js");
  const { EnforcingContributionStore } = await import("../../core/enforcing-store.js");

  const stores = createSqliteStores(dbPath);
  const cas = new FsCas(join(groveDir, "cas"));
  const frontier = new DefaultFrontierCalculator(stores.contributionStore);

  // Load contract for enforcement and mode resolution.
  //
  // Config resolution precedence:
  //   1. session.config (frozen snapshot from #198) when GROVE_SESSION_ID is set
  //      and the session has a stored config — use it, skip GROVE.md entirely.
  //   2. Live GROVE.md — used when no session, or when session exists but
  //      has no stored config (configless sessions are valid: orchestrator
  //      calls createSession with config=undefined when GROVE.md is absent;
  //      legacy pre-#198 sessions also lack config).
  //   3. No enforcement — neither session config nor GROVE.md available.
  //
  // Falling back to GROVE.md on missing session config preserves pre-PR
  // behavior for configless sessions. This is a compat case, not silent
  // drift — the only path where drift matters (session with config) takes
  // precedence and never falls through.
  let contract: Awaited<ReturnType<typeof parseGroveContract>> | undefined;
  const envSessionId = process.env.GROVE_SESSION_ID;
  if (envSessionId) {
    contract = stores.goalSessionStore.getSessionConfigSync(envSessionId);
  }
  if (contract === undefined) {
    // Load GROVE.md from the grove root (parent of .grove/).
    //
    // ENOENT is the only acceptable fallthrough. Everything else (parse
    // errors, permission denied, schema validation) propagates to the
    // outer error handler so the operator sees the failure.
    const groveRoot = join(groveDir, "..");
    const grovemdPath = join(groveRoot, "GROVE.md");
    let grovemdContent: string | undefined;
    try {
      grovemdContent = await readFile(grovemdPath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
      // GROVE.md does not exist — proceed without enforcement
    }
    if (grovemdContent !== undefined) {
      contract = parseGroveContract(grovemdContent);
    }
  }

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

    const result = await contributeOperation(
      {
        kind: "discussion",
        mode: options.mode as ContributionMode | undefined,
        summary: options.message,
        description: options.description,
        relations,
        tags: [...options.tags],
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
