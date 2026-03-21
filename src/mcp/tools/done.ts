/**
 * MCP tool for signaling agent completion.
 *
 * grove_done — Signal that this agent has finished its work for the session.
 *
 * When an agent calls grove_done, it creates a contribution with kind=work
 * and context.done=true. Other agents see this via grove_log and know the
 * signaling agent is finished. The TUI watches for done signals from all
 * roles to transition to the Complete screen.
 *
 * This is the explicit stop condition for review loops where there's no
 * numeric threshold — the reviewer calls grove_done when satisfied, the
 * coder calls grove_done when it has no more work.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { JsonValue } from "../../core/models.js";
import { contributeOperation } from "../../core/operations/index.js";
import type { McpDeps } from "../deps.js";
import { toMcpResult, toOperationDeps } from "../operation-adapter.js";
import { agentSchema } from "../schemas.js";

const doneInputSchema = z.object({
  summary: z
    .string()
    .describe("Why you are done. E.g., 'Code review approved — no more changes needed.'"),
  agent: agentSchema,
});

export function registerDoneTools(server: McpServer, deps: McpDeps): void {
  const opDeps = toOperationDeps(deps);

  server.registerTool(
    "grove_done",
    {
      description:
        "Signal that you have finished your work for this session. " +
        "Call this when you have no more work to do — e.g., the reviewer " +
        "has approved the code, or the coder has addressed all feedback. " +
        "Other agents will see your done signal via grove_log and can " +
        "finish their own work. When all agents signal done, the session ends.",
      inputSchema: doneInputSchema,
    },
    async (args) => {
      const result = await contributeOperation(
        {
          kind: "discussion",
          summary: `[DONE] ${args.summary}`,
          context: {
            done: true,
            reason: args.summary,
          } as Readonly<Record<string, JsonValue>>,
          agent: {
            ...(args.agent as import("../../core/operations/agent.js").AgentOverrides),
            ...(process.env.GROVE_AGENT_ROLE ? { role: process.env.GROVE_AGENT_ROLE } : {}),
          },
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );
}
