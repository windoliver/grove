/**
 * MCP tools for session management.
 *
 * grove_list_sessions   — List sessions with optional status filter
 * grove_create_session  — Create a new session
 *
 * Accesses the GoalSessionStore directly via McpDeps.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpDeps } from "../deps.js";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listSessionsInputSchema = z.object({
  status: z
    .enum(["active", "archived"])
    .optional()
    .describe("Filter sessions by status. Omit to list all sessions."),
});

const createSessionInputSchema = z.object({
  goal: z
    .string()
    .optional()
    .describe("Optional goal description to associate with the new session"),
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerSessionTools(server: McpServer, deps: McpDeps): void {
  // --- grove_list_sessions -------------------------------------------------
  server.registerTool(
    "grove_list_sessions",
    {
      description:
        "List sessions with optional status filter. Returns session records including " +
        "session ID, goal, status, timestamps, and contribution count.",
      inputSchema: listSessionsInputSchema,
    },
    async (args) => {
      const store = deps.goalSessionStore;
      if (!store) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "[NOT_CONFIGURED] Goal/session store is not configured",
            },
          ],
        };
      }

      const query = args.status !== undefined ? { status: args.status } : undefined;
      const sessions = await store.listSessions(query);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: sessions.length, sessions }),
          },
        ],
      };
    },
  );

  // --- grove_create_session ------------------------------------------------
  server.registerTool(
    "grove_create_session",
    {
      description:
        "Create a new session to group contributions. Optionally associate a goal " +
        "description with the session. Returns the new session record with its generated ID.",
      inputSchema: createSessionInputSchema,
    },
    async (args) => {
      const store = deps.goalSessionStore;
      if (!store) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "[NOT_CONFIGURED] Goal/session store is not configured",
            },
          ],
        };
      }

      const session = await store.createSession({
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(session),
          },
        ],
      };
    },
  );
}
