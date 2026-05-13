/**
 * MCP tool for local trajectory checking.
 *
 * grove_check_trajectory — Check local transcript JSONL against trajectory rules
 *
 * All business logic is delegated to the shared operations layer.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CheckTrajectoryInput } from "../../core/operations/index.js";
import { checkTrajectoryOperation } from "../../core/operations/index.js";
import { assertWithinBoundary } from "../../core/path-safety.js";
import type { McpDeps } from "../deps.js";
import { handleToolError } from "../error-handler.js";
import { toMcpResult } from "../operation-adapter.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DEFAULT_SPEC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../spec/trajectory/common.yaml",
);

const trajectoryInputSchema = {
  transcriptPath: z.string().min(1).describe("Path to the local transcript JSONL file"),
  specPaths: z
    .array(z.string().min(1))
    .min(1)
    .default([DEFAULT_SPEC_PATH])
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

export function registerTrajectoryTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "grove_check_trajectory",
    {
      description:
        "Check local agent transcript JSONL against deterministic Grove trajectory YAML rules.",
      inputSchema: trajectoryInputSchema,
    },
    async (args) => {
      try {
        const input = await resolveTrajectoryInput(args, deps);
        const result = await checkTrajectoryOperation(input);
        return toMcpResult(result);
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}

async function resolveTrajectoryInput(
  args: {
    transcriptPath: string;
    specPaths?: readonly string[] | undefined;
    runtime: CheckTrajectoryInput["runtime"];
    format: CheckTrajectoryInput["format"];
    annotatedLogPath?: string | undefined;
  },
  deps: McpDeps,
): Promise<CheckTrajectoryInput> {
  const specPaths = args.specPaths ?? [DEFAULT_SPEC_PATH];
  const resolvedSpecPaths = await Promise.all(
    specPaths.map((specPath) =>
      specPath === DEFAULT_SPEC_PATH
        ? Promise.resolve(DEFAULT_SPEC_PATH)
        : assertWithinBoundary(specPath, deps.workspaceBoundary),
    ),
  );
  const annotatedLogPath =
    args.annotatedLogPath !== undefined
      ? await assertWithinBoundary(args.annotatedLogPath, deps.workspaceBoundary)
      : undefined;

  return {
    transcriptPath: await assertWithinBoundary(args.transcriptPath, deps.workspaceBoundary),
    specPaths: resolvedSpecPaths,
    runtime: args.runtime,
    format: args.format,
    ...(annotatedLogPath !== undefined ? { annotatedLogPath } : {}),
  };
}
