/**
 * MCP tools for plan operations.
 *
 * grove_create_plan — Create a new project plan with tasks
 * grove_update_plan — Update an existing plan (new version with derives_from)
 *
 * All business logic is delegated to the shared operations layer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AgentOverrides } from "../../core/operations/agent.js";
import { createPlanOperation, updatePlanOperation } from "../../core/operations/index.js";
import type { PlanTask } from "../../core/operations/plan.js";
import type { McpDeps } from "../deps.js";
import { toMcpResult, toOperationDeps } from "../operation-adapter.js";
import { agentSchema } from "../schemas.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const planTaskSchema = z.object({
  id: z.string().describe("Unique task identifier"),
  title: z.string().describe("Task title"),
  status: z.enum(["todo", "in_progress", "done", "blocked"]).describe("Task status"),
  assignee: z.string().optional().describe("Agent handle assigned to this task"),
});

const createPlanInputSchema = z.object({
  title: z.string().describe("Plan title"),
  tasks: z.array(planTaskSchema).min(1).describe("List of plan tasks"),
  description: z.string().optional().describe("Plan description"),
  tags: z.array(z.string()).optional().default([]).describe("Tags for filtering"),
  agent: agentSchema,
});

const updatePlanInputSchema = z.object({
  previous_plan_cid: z.string().describe("CID of the plan being updated"),
  tasks: z.array(planTaskSchema).min(1).describe("Updated list of plan tasks"),
  title: z.string().optional().describe("Updated plan title (defaults to previous)"),
  description: z.string().optional().describe("Updated plan description"),
  tags: z.array(z.string()).optional().default([]).describe("Tags for filtering"),
  agent: agentSchema,
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerPlanTools(server: McpServer, deps: McpDeps): void {
  const opDeps = toOperationDeps(deps);

  // --- grove_create_plan ---------------------------------------------------
  server.registerTool(
    "grove_create_plan",
    {
      description:
        "Create a new project plan with tasks. Plans are tracked as contributions " +
        "with kind=plan. Each task has an id, title, status (todo/in_progress/done/blocked), " +
        "and optional assignee. Use grove_update_plan to update the plan later.",
      inputSchema: createPlanInputSchema,
    },
    async (args) => {
      const result = await createPlanOperation(
        {
          title: args.title,
          tasks: args.tasks as unknown as readonly PlanTask[],
          ...(args.description !== undefined ? { description: args.description } : {}),
          tags: args.tags,
          agent: args.agent as AgentOverrides,
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_update_plan ---------------------------------------------------
  server.registerTool(
    "grove_update_plan",
    {
      description:
        "Update an existing plan. Creates a new plan version linked to the previous one " +
        "via derives_from. Pass the full updated task list — this replaces the previous tasks.",
      inputSchema: updatePlanInputSchema,
    },
    async (args) => {
      const result = await updatePlanOperation(
        {
          previousPlanCid: args.previous_plan_cid,
          tasks: args.tasks as unknown as readonly PlanTask[],
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          tags: args.tags,
          agent: args.agent as AgentOverrides,
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );
}
