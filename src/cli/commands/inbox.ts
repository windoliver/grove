/**
 * `grove inbox` command — send and read agent-to-agent messages.
 *
 * Subcommands:
 *   grove inbox send "message" --to @reviewer [--reply-to <cid>] [--tag <tag>] [--json]
 *   grove inbox read [--from <agent-id>] [--since <iso>] [--limit <n>] [--json]
 */

import { parseArgs } from "node:util";
import type { AgentOverrides } from "../../core/operations/agent.js";
import { resolveAgent } from "../../core/operations/agent.js";
import type { OperationDeps } from "../../core/operations/deps.js";
import { readInbox, sendMessageAsDiscussion } from "../../core/operations/messaging.js";
import type { CliDeps } from "../context.js";
import { formatTable, formatTimestamp, outputJson } from "../format.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleInbox(args: readonly string[], groveOverride?: string): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "send") {
    await handleSend(args.slice(1), groveOverride);
  } else if (subcommand === "read") {
    await handleRead(args.slice(1), groveOverride);
  } else {
    console.error("Usage: grove inbox send|read [options]");
    process.exitCode = 2;
  }
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

async function handleSend(args: readonly string[], groveOverride?: string): Promise<void> {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      to: { type: "string", multiple: true, default: [] },
      "reply-to": { type: "string" },
      tag: { type: "string", multiple: true, default: [] },
      "agent-id": { type: "string" },
      "agent-name": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const body = positionals.join(" ").trim();
  if (!body) {
    console.error('Usage: grove inbox send "message" --to @recipient');
    process.exitCode = 2;
    return;
  }

  const recipients = (values.to ?? []) as string[];
  if (recipients.length === 0) {
    console.error("Error: --to is required (e.g., --to @reviewer or --to @all)");
    process.exitCode = 2;
    return;
  }

  const { initCliDeps } = await import("../context.js");
  const deps = initCliDeps(process.cwd(), groveOverride);

  try {
    const agentOverrides: AgentOverrides = {
      agentId: values["agent-id"] as string | undefined,
      agentName: values["agent-name"] as string | undefined,
    };

    const result = await sendMessageAsDiscussion(
      {
        agent: agentOverrides,
        body,
        recipients,
        ...(values["reply-to"] !== undefined ? { inReplyTo: values["reply-to"] as string } : {}),
        tags: (values.tag ?? []) as string[],
      },
      cliDepsToOperationDeps(deps),
    );

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exitCode = 1;
      return;
    }

    if (values.json) {
      outputJson({ cid: result.value.cid, recipients, body });
    } else {
      console.log(`Message sent: ${result.value.cid}`);
      console.log(`  to: ${recipients.join(", ")}`);
    }
  } finally {
    deps.close();
  }
}

/**
 * Adapter: project CliDeps to the subset of OperationDeps needed for
 * sendMessageAsDiscussion. CLI is single-process and synchronous, so
 * topology / handoffs / hooks are not configured.
 */
function cliDepsToOperationDeps(deps: CliDeps): OperationDeps {
  return {
    contributionStore: deps.store,
    claimStore: deps.claimStore,
    cas: deps.cas,
    frontier: deps.frontier,
    ...(deps.outcomeStore !== undefined ? { outcomeStore: deps.outcomeStore } : {}),
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function handleRead(args: readonly string[], groveOverride?: string): Promise<void> {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      from: { type: "string" },
      since: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const { initCliDeps } = await import("../context.js");
  const deps = initCliDeps(process.cwd(), groveOverride);

  try {
    // Scope to current agent's inbox — match messages addressed to this
    // agent's ID handle (@agentId), role handle (@role), or broadcast (@all).
    const agent = resolveAgent();
    const myHandles = [`@${agent.agentId}`];
    if (agent.role) myHandles.push(`@${agent.role}`);
    myHandles.push("@all");

    const messages = await readInbox(deps.store, {
      recipients: myHandles,
      fromAgentId: values.from as string | undefined,
      since: values.since as string | undefined,
      limit: values.limit !== undefined ? Number(values.limit) : undefined,
    });

    if (values.json) {
      outputJson(messages);
      return;
    }

    if (messages.length === 0) {
      console.log("(no messages)");
      return;
    }

    const columns = [
      { header: "FROM", key: "from", maxWidth: 20 },
      { header: "MESSAGE", key: "message", maxWidth: 50 },
      { header: "TIME", key: "time", maxWidth: 16 },
    ];

    const rows = messages.map((m) => ({
      from: m.from.agentName ?? m.from.agentId,
      message: m.body.length > 50 ? `${m.body.slice(0, 48)}..` : m.body,
      time: formatTimestamp(m.createdAt),
    }));

    console.log(formatTable(columns, rows));
  } finally {
    deps.close();
  }
}
