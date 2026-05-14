import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { RuntimeSkillAcquisitionError } from "../../core/runtime-skill-acquisition.js";
import type { McpDeps } from "../deps.js";
import { toolError } from "../error-handler.js";

const requestSkillInputSchema = z.object({
  skillName: z.string().min(1).max(128).describe("Name of the skill to request"),
  reason: z.string().max(1000).optional().describe("Why the agent needs this skill"),
});

function callerRole(): string | undefined {
  const role = process.env.GROVE_AGENT_ROLE;
  return role && role.length > 0 ? role : undefined;
}

function runtimeSkillErrorResult(error: RuntimeSkillAcquisitionError): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          code: error.code,
          message: error.message,
          workspaceInstalled: error.workspaceInstalled,
          installedTargets: error.installedTargets,
        }),
      },
    ],
  };
}

export function registerRuntimeSkillTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "grove_request_skill",
    {
      description:
        "Request an allowlisted Grove skill at runtime. Installs it into the live workspace and returns bounded SKILL.md content for immediate use.",
      inputSchema: requestSkillInputSchema,
    },
    async (args) => {
      if (deps.runtimeSkillService === undefined) {
        return toolError("NOT_CONFIGURED", "Runtime skill acquisition is not configured");
      }

      const role = callerRole();
      if (role === undefined) {
        return toolError("NOT_AUTHORIZED", "Runtime skill request has no bound agent role");
      }

      try {
        const result = await deps.runtimeSkillService.requestSkill({
          skillName: args.skillName,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          caller: {
            role,
            ...(process.env.GROVE_AGENT_ID ? { agentId: process.env.GROVE_AGENT_ID } : {}),
            ...(process.env.GROVE_SESSION_ID ? { sessionId: process.env.GROVE_SESSION_ID } : {}),
            workspacePath: process.cwd(),
          },
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        if (error instanceof RuntimeSkillAcquisitionError) {
          return runtimeSkillErrorResult(error);
        }
        throw error;
      }
    },
  );
}
