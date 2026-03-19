/**
 * MCP tool: grove_wait_for_event — push-based event waiting.
 *
 * Replaces polling-based loops. Blocks until a relevant event occurs
 * (new contribution, inbox message, frontier change) or timeout.
 *
 * Uses the in-process contribution write callback as the primary signal.
 * When connected to Nexus, can optionally poll the Nexus IPC inbox endpoint
 * for distributed events from remote agents.
 *
 * The tool is "dynamic" — it checks the actual state after waking up,
 * so it works regardless of whether the wake signal came from local writes,
 * Nexus IPC, or a timeout-based poll.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ContributionKind } from "../../core/models.js";
import type { ContributionStore } from "../../core/store.js";
import type { InboxMessage } from "../../core/operations/messaging.js";
import { readInbox } from "../../core/operations/messaging.js";
import type { McpDeps } from "../deps.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const waitForEventInputSchema = z.object({
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(120)
    .optional()
    .default(30)
    .describe("Max seconds to wait before returning (default: 30, max: 120)"),
  inbox: z
    .boolean()
    .optional()
    .default(true)
    .describe("Watch for new inbox messages (default: true)"),
  contributions: z
    .boolean()
    .optional()
    .default(true)
    .describe("Watch for new contributions (default: true)"),
  since: z
    .string()
    .optional()
    .describe("Only return events after this ISO timestamp (default: now)"),
  recipient: z
    .string()
    .optional()
    .describe('Filter inbox to this handle (e.g., "@coder", "@all")'),
  kind: z
    .enum(["work", "review", "discussion", "adoption", "reproduction", "plan"])
    .optional()
    .describe("Filter contributions to this kind"),
});

// ---------------------------------------------------------------------------
// Event result types
// ---------------------------------------------------------------------------

interface WaitResult {
  readonly timed_out: boolean;
  readonly waited_seconds: number;
  readonly new_messages: readonly InboxMessage[];
  readonly new_contributions: readonly {
    cid: string;
    kind: string;
    summary: string;
    agent: string;
    createdAt: string;
  }[];
}

// ---------------------------------------------------------------------------
// Core wait logic
// ---------------------------------------------------------------------------

/**
 * Wait for new events by combining:
 * 1. In-process signal via onContributionWrite callback (instant for local writes)
 * 2. Periodic state check (catches Nexus IPC / remote writes)
 * 3. Timeout fallback
 */
async function waitForEvent(
  deps: McpDeps,
  args: z.infer<typeof waitForEventInputSchema>,
): Promise<WaitResult> {
  const startTime = Date.now();
  const timeoutMs = args.timeout_seconds * 1000;
  const since = args.since ?? new Date().toISOString();
  const sinceMs = Date.parse(since);

  // Poll interval for checking Nexus/remote state (backs up the push signal)
  const POLL_INTERVAL_MS = 3_000;

  // Helper: check for new inbox messages
  const checkInbox = async (): Promise<readonly InboxMessage[]> => {
    if (!args.inbox) return [];
    return readInbox(deps.contributionStore, {
      since,
      ...(args.recipient ? { recipient: args.recipient } : {}),
      limit: 20,
    });
  };

  // Helper: check for new contributions
  const checkContributions = async () => {
    if (!args.contributions) return [];
    const kindFilter = args.kind
      ? (ContributionKind[
          (args.kind.charAt(0).toUpperCase() + args.kind.slice(1)) as keyof typeof ContributionKind
        ] as ContributionKind | undefined)
      : undefined;

    const contribs = await deps.contributionStore.list({
      ...(kindFilter !== undefined ? { kind: kindFilter } : {}),
      limit: 50,
    });

    return contribs
      .filter((c) => {
        if (c.context?.ephemeral === true) return false; // skip messages
        if (Date.parse(c.createdAt) <= sinceMs) return false;
        return true;
      })
      .slice(0, 20)
      .map((c) => ({
        cid: c.cid,
        kind: c.kind,
        summary: c.summary,
        agent: c.agent.agentId,
        createdAt: c.createdAt,
      }));
  };

  // Helper: check if there are any new events
  const checkAll = async () => {
    const [messages, contributions] = await Promise.all([checkInbox(), checkContributions()]);
    return { messages, contributions };
  };

  // First check immediately — there may already be events waiting
  {
    const { messages, contributions } = await checkAll();
    if (messages.length > 0 || contributions.length > 0) {
      return {
        timed_out: false,
        waited_seconds: 0,
        new_messages: messages,
        new_contributions: contributions,
      };
    }
  }

  // Set up a promise that resolves when onContributionWrite fires
  let resolveSignal: (() => void) | undefined;
  const signalPromise = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });

  // Hook into the contribution write callback
  const originalCallback = deps.onContributionWrite;
  let signalFired = false;
  deps.onContributionWrite = () => {
    originalCallback?.();
    signalFired = true;
    resolveSignal?.();
  };

  try {
    const deadline = startTime + timeoutMs;

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      // Race: contribution write signal vs poll interval vs timeout
      const waitTime = Math.min(POLL_INTERVAL_MS, remaining);
      await Promise.race([
        signalPromise,
        new Promise<void>((resolve) => setTimeout(resolve, waitTime)),
      ]);

      // If signal fired, recreate the promise for next iteration
      if (signalFired) {
        signalFired = false;
        // Create new signal promise for potential next wait
        const newPromise = new Promise<void>((resolve) => {
          resolveSignal = resolve;
        });
        void newPromise; // TypeScript unused var
      }

      // Check for new events
      const { messages, contributions } = await checkAll();
      if (messages.length > 0 || contributions.length > 0) {
        return {
          timed_out: false,
          waited_seconds: Math.round((Date.now() - startTime) / 1000),
          new_messages: messages,
          new_contributions: contributions,
        };
      }
    }

    // Timeout — return empty result
    return {
      timed_out: true,
      waited_seconds: args.timeout_seconds,
      new_messages: [],
      new_contributions: [],
    };
  } finally {
    // Restore original callback
    deps.onContributionWrite = originalCallback;
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerEventTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "grove_wait_for_event",
    {
      description:
        "Block until a new contribution or inbox message appears, or timeout. " +
        "Replaces manual polling of grove_frontier + grove_read_inbox. " +
        "Returns new events since the given timestamp (or since call time). " +
        "Use this at the top of your work loop instead of repeatedly calling " +
        "grove_frontier — you will be notified as soon as new work appears.",
      inputSchema: waitForEventInputSchema,
    },
    async (args) => {
      const result = await waitForEvent(deps, args);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}
