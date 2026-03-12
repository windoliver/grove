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

import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { ContributionMode } from "../../core/models.js";
import { RelationType } from "../../core/models.js";
import type { OperationDeps } from "../../core/operations/index.js";
import { contributeOperation } from "../../core/operations/index.js";
import { outputJson } from "../format.js";

export interface DiscussOptions {
  readonly respondsTo?: string | undefined;
  readonly message: string;
  readonly tags: readonly string[];
  readonly mode?: "evaluation" | "exploration" | undefined;
  readonly description?: string | undefined;
  readonly json?: boolean | undefined;
  readonly cwd: string;
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
    cwd: process.cwd(),
  };
}

/**
 * Execute `grove discuss` by initializing the store and calling discussOperation.
 */
export async function executeDiscuss(options: DiscussOptions): Promise<{ cid: string }> {
  // Find .grove/
  const grovePath = join(options.cwd, ".grove");
  try {
    await access(grovePath);
  } catch {
    throw new Error("No grove found. Run 'grove init' first to create a grove in this directory.");
  }

  // Dynamic imports for lazy loading
  const { SqliteContributionStore, SqliteClaimStore, initSqliteDb } = await import(
    "../../local/sqlite-store.js"
  );
  const { FsCas } = await import("../../local/fs-cas.js");
  const { DefaultFrontierCalculator } = await import("../../core/frontier.js");
  const { parseGroveContract } = await import("../../core/contract.js");
  const { EnforcingContributionStore } = await import("../../core/enforcing-store.js");

  const dbPath = join(grovePath, "grove.db");
  const casPath = join(grovePath, "cas");
  const db = initSqliteDb(dbPath);
  const rawStore = new SqliteContributionStore(db);
  const claimStore = new SqliteClaimStore(db);
  const cas = new FsCas(casPath);
  const frontier = new DefaultFrontierCalculator(rawStore);

  // Load GROVE.md contract for enforcement and mode resolution
  const grovemdPath = join(options.cwd, "GROVE.md");
  let contract: Awaited<ReturnType<typeof parseGroveContract>> | undefined;
  let grovemdContent: string | undefined;
  try {
    grovemdContent = await readFile(grovemdPath, "utf-8");
  } catch {
    // GROVE.md does not exist — proceed without enforcement
  }
  if (grovemdContent !== undefined) {
    contract = parseGroveContract(grovemdContent);
  }

  // Wrap store with enforcement if contract is available
  const store = contract ? new EnforcingContributionStore(rawStore, contract, { cas }) : rawStore;

  try {
    const opDeps: OperationDeps = {
      contributionStore: store,
      claimStore,
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
    db.close();
  }
}

/** Handle the `grove discuss` CLI command. */
export async function handleDiscuss(
  args: readonly string[],
  groveOverride?: string,
): Promise<void> {
  const options = parseDiscussArgs(args);
  // If --grove override is provided, derive cwd from it (parent of .grove dir)
  const cwd = groveOverride ? dirname(resolve(groveOverride)) : options.cwd;
  await executeDiscuss({ ...options, cwd });
}
