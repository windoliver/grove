/**
 * MCP tool for stop condition evaluation.
 *
 * grove_check_stop — Check if grove stop conditions are met
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { JsonValue } from "../../core/models.js";
import type { McpDeps } from "../deps.js";
import { handleToolError } from "../error-handler.js";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerStopTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "grove_check_stop",
    {
      description:
        "Check whether the grove's stop conditions are met. Returns a structured result " +
        "with each condition's status, reason, and details. The grove is considered stopped " +
        "if ANY condition is met. Call this after each contribution to decide whether to continue. " +
        "Returns {stopped: false} if no GROVE.md contract is defined.",
      inputSchema: {},
    },
    async () => {
      try {
        const { contract, contributionStore } = deps;

        if (contract === undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  stopped: false,
                  reason: "No GROVE.md contract defined — stop conditions not configured",
                  conditions: {},
                  evaluatedAt: new Date().toISOString(),
                }),
              },
            ],
          };
        }

        // Lazy import to avoid circular dependency at module load time.
        const { evaluateStopConditions } = await import("../../core/lifecycle.js");
        const result = await evaluateStopConditions(contract, contributionStore);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                stopped: result.stopped,
                reason: result.stopped
                  ? Object.entries(result.conditions)
                      .filter(([, c]) => c.met)
                      .map(([name, c]) => `${name}: ${c.reason}`)
                      .join("; ")
                  : "No stop conditions met",
                conditions: result.conditions as unknown as Readonly<Record<string, JsonValue>>,
                evaluatedAt: result.evaluatedAt,
              }),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
