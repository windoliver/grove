/**
 * MCP tool for local trajectory checking.
 *
 * grove_check_trajectory — Check local transcript JSONL against trajectory rules
 *
 * All business logic is delegated to the shared operations layer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { checkTrajectoryOperation } from "../../core/operations/index.js";
import type { McpDeps } from "../deps.js";
import { toMcpResult } from "../operation-adapter.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const trajectoryInputSchema = {
  transcriptPath: z.string().min(1).describe("Path to the local transcript JSONL file"),
  specPaths: z
    .array(z.string().min(1))
    .min(1)
    .default(["spec/trajectory/common.yaml"])
    .describe("Trajectory YAML spec paths to evaluate"),
  runtime: z
    .enum(["auto", "acpx", "codex", "claude-stream-json", "subprocess", "unknown"])
    .default("auto")
    .describe("Transcript runtime/parser to use"),
  format: z.enum(["markdown", "json"]).default("json").describe("Report output format"),
  annotatedLogPath: z.string().min(1).optional().describe("Optional path for annotated log output"),
};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTrajectoryTools(server: McpServer, _deps: McpDeps): void {
  server.registerTool(
    "grove_check_trajectory",
    {
      description:
        "Check local agent transcript JSONL against deterministic Grove trajectory YAML rules.",
      inputSchema: trajectoryInputSchema,
    },
    async (args) => {
      const result = await checkTrajectoryOperation({
        transcriptPath: args.transcriptPath,
        specPaths: args.specPaths,
        runtime: args.runtime,
        format: args.format,
        ...(args.annotatedLogPath !== undefined ? { annotatedLogPath: args.annotatedLogPath } : {}),
      });
      return toMcpResult(result);
    },
  );
}
