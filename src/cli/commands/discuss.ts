/**
 * grove discuss — shorthand for posting discussions and replies.
 *
 * Usage:
 *   grove discuss "Should we use polling or push?"           # root discussion
 *   grove discuss blake3:abc123 "I think push is better"    # reply to thread
 *   grove discuss blake3:abc123 "Push wins" --tag arch      # reply with tags
 *   grove discuss "New topic" --tag design --mode exploration
 */

import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type ContributeOptions, executeContribute } from "./contribute.js";

export interface DiscussOptions {
  readonly respondsTo?: string | undefined;
  readonly message: string;
  readonly tags: readonly string[];
  readonly mode?: "evaluation" | "exploration" | undefined;
  readonly description?: string | undefined;
  readonly cwd: string;
}

/**
 * Parse `grove discuss` arguments.
 *
 * Positional args: [cid] <message>
 *   - If one positional: it's the message (root discussion)
 *   - If two positionals: first is CID, second is message (reply)
 * Flags: --tag, --mode, --description
 */
export function parseDiscussArgs(args: readonly string[]): DiscussOptions {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      tag: { type: "string", multiple: true, default: [] },
      mode: { type: "string" },
      description: { type: "string" },
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
    cwd: process.cwd(),
  };
}

/**
 * Execute `grove discuss` by mapping to ContributeOptions and calling executeContribute.
 */
export async function executeDiscuss(options: DiscussOptions): Promise<{ cid: string }> {
  const contributeOptions: ContributeOptions = {
    kind: "discussion",
    mode: options.mode,
    summary: options.message,
    description: options.description,
    artifacts: [],
    fromGitTree: false,
    parent: undefined,
    reviews: undefined,
    respondsTo: options.respondsTo,
    adopts: undefined,
    reproduces: undefined,
    metric: [],
    score: [],
    tags: [...options.tags],
    agentOverrides: {},
    cwd: options.cwd,
  };

  return executeContribute(contributeOptions);
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
