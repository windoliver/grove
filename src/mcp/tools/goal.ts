/**
 * MCP tools for goal management.
 *
 * grove_goal     — Read the current goal
 * grove_set_goal — Set or update the current goal
 *
 * Accesses the GoalSessionStore directly via McpDeps.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpDeps } from "../deps.js";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const setGoalInputSchema = z.object({
  goal: z.string().min(1).describe("The goal text describing what should be achieved"),
  acceptance: z
    .array(z.string().min(1))
    .optional()
    .default([])
    .describe(
      "Acceptance criteria — list of conditions that must be met for the goal to be complete",
    ),
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGoalTools(server: McpServer, deps: McpDeps): void {
  // --- grove_goal ----------------------------------------------------------
  server.registerTool(
    "grove_goal",
    {
      description:
        "Read the current goal for the grove session. Returns the goal text, acceptance " +
        "criteria, status, and metadata. Returns a message if no goal has been set.",
      inputSchema: {},
    },
    async () => {
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

      const goalData = await store.getGoal();
      if (!goalData) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ message: "No goal set" }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(goalData),
          },
        ],
      };
    },
  );

  // --- grove_set_goal ------------------------------------------------------
  server.registerTool(
    "grove_set_goal",
    {
      description:
        "Set or update the current goal for the grove session. Provide a goal description " +
        "and optional acceptance criteria. The goal is stored as a single-row upsert — " +
        "calling this replaces any previously set goal.",
      inputSchema: setGoalInputSchema,
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

      const result = await store.setGoal(args.goal, args.acceptance, "mcp");
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
}
