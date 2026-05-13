/**
 * MCP tools for session management.
 *
 * grove_list_sessions   — List sessions with optional status filter
 * grove_create_session  — Create a new session
 * grove_delete_session  — Delete a session
 * grove_session_delete_blockers — List blockers preventing session deletion
 *
 * Accesses the GoalSessionStore directly via McpDeps.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpDeps } from "../deps.js";
import { toolError } from "../error-handler.js";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listSessionsInputSchema = z.object({
  status: z
    .enum(["active", "archived"])
    .optional()
    .describe("Filter sessions by status. Omit to list all sessions."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(20)
    .describe("Maximum number of sessions to return (default: 20, max: 100)"),
  offset: z.number().int().min(0).optional().default(0).describe("Pagination offset"),
});

const createSessionInputSchema = z.object({
  goal: z
    .string()
    .optional()
    .describe("Optional goal description to associate with the new session"),
});

const deleteSessionInputSchema = z.object({
  sessionId: z.string().min(1).describe("Session ID to delete"),
  force: z.boolean().optional().default(false).describe("Force deletion past pending finalizers"),
  actor: z.string().optional().default("mcp").describe("Actor recorded in deletion audit events"),
});

const sessionDeleteBlockersInputSchema = z.object({
  sessionId: z.string().min(1).describe("Session ID to inspect for delete blockers"),
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
        return toolError("NOT_CONFIGURED", "Goal/session store is not configured");
      }

      const query = args.status !== undefined ? { status: args.status } : undefined;
      const sessions = await store.listSessions(query);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 20;
      const pagedSessions = sessions.slice(offset, offset + limit);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              count: pagedSessions.length,
              total: sessions.length,
              sessions: pagedSessions,
            }),
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
        return toolError("NOT_CONFIGURED", "Goal/session store is not configured");
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

  // --- grove_delete_session -----------------------------------------------
  server.registerTool(
    "grove_delete_session",
    {
      description:
        "Delete a session. Normal deletion runs session finalizers and returns blockers " +
        "when deletion cannot complete. Set force=true to remove sessions with pending finalizers.",
      inputSchema: deleteSessionInputSchema,
    },
    async (args) => {
      const store = deps.goalSessionStore;
      if (!store) {
        return toolError("NOT_CONFIGURED", "Goal/session store is not configured");
      }

      const session = await store.getSession(args.sessionId);
      if (!session) {
        return toolError("NOT_FOUND", `Session not found: ${args.sessionId}`);
      }

      const result = await store.deleteSession(args.sessionId, {
        force: args.force ?? false,
        actor: args.actor ?? "mcp",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  // --- grove_session_delete_blockers --------------------------------------
  server.registerTool(
    "grove_session_delete_blockers",
    {
      description: "List blockers that currently prevent a session from being deleted.",
      inputSchema: sessionDeleteBlockersInputSchema,
    },
    async (args) => {
      const store = deps.goalSessionStore;
      if (!store) {
        return toolError("NOT_CONFIGURED", "Goal/session store is not configured");
      }

      const session = await store.getSession(args.sessionId);
      if (!session) {
        return toolError("NOT_FOUND", `Session not found: ${args.sessionId}`);
      }

      const blockers = await store.listSessionDeleteBlockers(args.sessionId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ sessionId: args.sessionId, blockers }),
          },
        ],
      };
    },
  );
}
