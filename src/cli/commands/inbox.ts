/**
 * `grove inbox` command — send and read agent-to-agent messages.
 *
 * Subcommands:
 *   grove inbox send "message" --to @reviewer [--reply-to <cid>] [--tag <tag>] [--json]
 *   grove inbox read [--from <agent-id>] [--since <iso>] [--limit <n>] [--json]
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AgentOverrides } from "../../core/operations/agent.js";
import { resolveAgent } from "../../core/operations/agent.js";
import type { OperationDeps } from "../../core/operations/deps.js";
import type { InboxReadSource, MessageDelivery } from "../../core/operations/inbox-delegation.js";
import {
  readInboxWithSource,
  sendMessageWithDelivery,
} from "../../core/operations/inbox-delegation.js";
import type { InboxQuery } from "../../core/operations/messaging.js";
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

interface CliNexusInboxDeps {
  readonly inboxReadSource?: InboxReadSource | undefined;
  readonly messageDelivery?: MessageDelivery | undefined;
}

async function createCliNexusInboxDeps(): Promise<CliNexusInboxDeps> {
  const nexusUrl = process.env.GROVE_NEXUS_URL;
  const apiKey = process.env.NEXUS_API_KEY;
  if (nexusUrl === undefined || apiKey === undefined) return {};

  const sessionId = process.env.GROVE_SESSION_ID;
  const { NexusHttpClient } = await import("../../nexus/nexus-http-client.js");
  const { NexusInboxClient, NexusMessageDelivery } = await import(
    "../../nexus/nexus-inbox-client.js"
  );
  const { NexusIpcClient } = await import("../../nexus/nexus-ipc-client.js");
  const client = new NexusHttpClient({ url: nexusUrl, apiKey });

  return {
    inboxReadSource: new NexusInboxClient({
      nexusUrl,
      apiKey,
      sessionId,
      client,
    }),
    messageDelivery: new NexusMessageDelivery({
      ipcClient: new NexusIpcClient({ nexusUrl, apiKey, sessionId }),
    }),
  };
}

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

  // Mirror the `grove discuss` bootstrap so the CLI send path goes through
  // the same contract-enforcement pipeline as the MCP path. Previously this
  // command wrapped a bare `CliDeps` which carried no contract, so GROVE.md
  // role-kind rules and rate limits silently did not apply to inbox sends —
  // a loophole the MCP fix didn't close.
  const { resolveGroveDir } = await import("../utils/grove-dir.js");
  const { createSqliteStores } = await import("../../local/sqlite-store.js");
  const { FsCas } = await import("../../local/fs-cas.js");
  const { DefaultFrontierCalculator } = await import("../../core/frontier.js");
  const { EnforcingContributionStore } = await import("../../core/enforcing-store.js");
  const { resolveContract } = await import("../utils/resolve-contract.js");

  const { groveDir, dbPath } = resolveGroveDir(groveOverride);
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

  // Wrap with EnforcingContributionStore when a contract exists. Without
  // this, rate-limits / allowed-kinds / clock-skew checks would not fire
  // for inbox sends even when configured in GROVE.md.
  const contributionStore = contract
    ? new EnforcingContributionStore(stores.contributionStore, contract, { cas })
    : stores.contributionStore;

  try {
    const agentOverrides: AgentOverrides = {
      agentId: values["agent-id"] as string | undefined,
      agentName: values["agent-name"] as string | undefined,
    };

    const opDeps: OperationDeps = {
      contributionStore,
      claimStore: stores.claimStore,
      cas,
      frontier,
      handoffStore: stores.handoffStore,
      ...(contract !== undefined ? { contract } : {}),
    };

    const { messageDelivery } = await createCliNexusInboxDeps();
    const result = await sendMessageWithDelivery(
      {
        agent: agentOverrides,
        body,
        recipients,
        ...(values["reply-to"] !== undefined ? { inReplyTo: values["reply-to"] as string } : {}),
        tags: (values.tag ?? []) as string[],
      },
      opDeps,
      messageDelivery,
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
    stores.close();
  }
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

    const { inboxReadSource } = await createCliNexusInboxDeps();
    const inboxQuery: InboxQuery = {
      recipients: myHandles,
      fromAgentId: values.from as string | undefined,
      since: values.since as string | undefined,
      limit: values.limit !== undefined ? Number(values.limit) : undefined,
    };
    const messages = await readInboxWithSource(deps.store, inboxQuery, inboxReadSource);

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
