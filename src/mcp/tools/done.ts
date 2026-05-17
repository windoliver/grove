/**
 * MCP tool for signaling agent completion.
 *
 * grove_done — Signal that this agent has finished its work for the session.
 *
 * When an agent calls grove_done, it creates a contribution with
 * kind=discussion and context.done=true. The session ends when a required
 * session-ending role's done marker is observed.
 *
 * This is the explicit stop condition for review loops where there's no
 * numeric threshold — the reviewer calls grove_done when satisfied.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { JsonValue } from "../../core/models.js";
import type { AgentOverrides } from "../../core/operations/agent.js";
import { contributeOperation } from "../../core/operations/index.js";
import { bindAgentIdentity } from "../agent-binding.js";
import { readAgentTaskContext } from "../agent-task-context.js";
import { signalAgentTaskDone } from "../agent-task-done.js";
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
        "Call this only when your role is responsible for ending the session — " +
        "for example, when the reviewer has approved the code. A required " +
        "session-ending role's done signal ends the session.",
      inputSchema: doneInputSchema,
    },
    async (args) => {
      const taskCtx = readAgentTaskContext(process.env);
      if (taskCtx !== undefined) {
        try {
          await signalAgentTaskDone(taskCtx, args.summary, {
            baseUrl: process.env.GROVE_SERVER_URL,
            token: process.env.GROVE_API_TOKEN,
          });
        } catch (err) {
          process.stderr.write(
            `[grove-done] task=${taskCtx.taskId} POST /done failed (${err instanceof Error ? err.message : String(err)}); contribution write proceeding\n`,
          );
        }
      }

      const result = await contributeOperation(
        {
          kind: "discussion",
          summary: `[DONE] ${args.summary}`,
          // ephemeral: true routes grove_done through the same skip-handoff /
          // keep-route-event path reserved for done markers. A session
          // terminator should not create handoffs that wake downstream agents
          // with new work, but event-driven completion still needs the
          // contribution event.
          context: {
            done: true,
            reason: args.summary,
            ephemeral: true,
          } as Readonly<Record<string, JsonValue>>,
          agent: bindAgentIdentity(args.agent as AgentOverrides),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );
}
