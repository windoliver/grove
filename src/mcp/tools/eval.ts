/**
 * MCP tool for the eval harness.
 *
 * grove_eval — Run the contract's eval harness against a target CID and
 * return structured metric scores.
 *
 * All business logic is delegated to the shared operations layer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { evalOperation } from "../../core/operations/index.js";
import type { McpDeps } from "../deps.js";
import { toMcpResult, toOperationDeps } from "../operation-adapter.js";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerEvalTools(server: McpServer, deps: McpDeps): void {
  const opDeps = toOperationDeps(deps);

  server.registerTool(
    "grove_eval",
    {
      description:
        "Run the grove eval harness against a target contribution CID and return structured " +
        "metric scores. The eval command is spawned as a subprocess (via sh -c) with " +
        "GROVE_TARGET_CID set to targetCid. Score lines must follow the format: " +
        "'GROVE_SCORE <metric_name>=<value>' on stdout or stderr. " +
        "Call grove_contribute separately to record results as a reproduction contribution.",
      inputSchema: {
        targetCid: z
          .string()
          .min(1)
          .describe(
            "CID of the contribution artifact to evaluate (passed as GROVE_TARGET_CID env var)",
          ),
        evalCommand: z
          .string()
          .min(1)
          .describe(
            "Shell command to execute as the eval harness (e.g. 'python eval.py'). " +
              "Required in the current protocol version.",
          ),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(3_600_000)
          .optional()
          .describe(
            "Timeout in milliseconds before the subprocess is killed (default: 300000 = 5 min).",
          ),
      },
    },
    async (args) => {
      const result = await evalOperation(opDeps, {
        targetCid: args.targetCid,
        evalCommand: args.evalCommand,
        timeoutMs: args.timeoutMs,
      });
      return toMcpResult(result);
    },
  );
}
