/**
 * MCP tools for content ingestion.
 *
 * grove_cas_put        — Store content in CAS (inline text/base64 or file path)
 * grove_ingest_git_diff — Ingest a git diff into CAS
 * grove_ingest_git_tree — Ingest git-tracked files into CAS
 *
 * These tools provide MCP-accessible wrappers around the local ingestion
 * subsystem and CAS put operations.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ingestGitDiff } from "../../local/ingest/git-diff.js";
import { ingestGitTree } from "../../local/ingest/git-tree.js";
import type { McpDeps } from "../deps.js";
import { handleToolError } from "../error-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a successful MCP result with JSON text content. */
function successResult<T>(value: T): CallToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const casPutInputSchema = z.object({
  content: z
    .string()
    .optional()
    .describe(
      "Inline content to store. Interpreted according to `encoding` (default utf8). " +
        "Exactly one of `content` or `filePath` must be provided.",
    ),
  filePath: z
    .string()
    .optional()
    .describe(
      "Absolute path to a file whose bytes will be stored in CAS. " +
        "Exactly one of `content` or `filePath` must be provided.",
    ),
  encoding: z
    .enum(["utf8", "base64"])
    .default("utf8")
    .describe("Encoding of the `content` field. Ignored when `filePath` is used."),
  mediaType: z
    .string()
    .optional()
    .describe("Optional IANA media type (e.g., 'text/plain', 'application/json')."),
});

const ingestGitDiffInputSchema = z.object({
  ref: z
    .string()
    .default("HEAD")
    .describe("Git ref to diff against (e.g., 'HEAD', 'HEAD~1', 'main', a commit hash)."),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the git command. Defaults to the server's cwd."),
});

const ingestGitTreeInputSchema = z.object({
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the git command. Defaults to the server's cwd."),
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerIngestTools(server: McpServer, deps: McpDeps): void {
  // --- grove_cas_put -------------------------------------------------------
  server.registerTool(
    "grove_cas_put",
    {
      description:
        "Store content in the Content-Addressable Store (CAS). Accepts either inline " +
        "content (text or base64-encoded) or a file path. Returns the content hash " +
        "(blake3:<hex64>) which can be used as an artifact reference in contributions.",
      inputSchema: casPutInputSchema,
    },
    async (args) => {
      try {
        const { content, filePath, encoding, mediaType } = args;

        // Validate: exactly one of content or filePath must be provided
        if (content !== undefined && filePath !== undefined) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "[VALIDATION_ERROR] Provide exactly one of `content` or `filePath`, not both.",
              },
            ],
          };
        }
        if (content === undefined && filePath === undefined) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "[VALIDATION_ERROR] Provide exactly one of `content` or `filePath`.",
              },
            ],
          };
        }

        const putOptions = mediaType !== undefined ? { mediaType } : undefined;

        if (filePath !== undefined) {
          const hash = await deps.cas.putFile(filePath, putOptions);
          return successResult({ hash });
        }

        // content is defined (TypeScript narrows here)
        const data =
          encoding === "base64"
            ? Uint8Array.from(atob(content!), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(content!);

        const hash = await deps.cas.put(data, putOptions);
        return successResult({ hash });
      } catch (error: unknown) {
        return handleToolError(error);
      }
    },
  );

  // --- grove_ingest_git_diff -----------------------------------------------
  server.registerTool(
    "grove_ingest_git_diff",
    {
      description:
        "Run `git diff` against a ref and ingest the output into CAS. Returns a map of " +
        "artifact names to content hashes. If the diff is empty, returns an empty map. " +
        "Reuses the local git-diff ingestion pipeline.",
      inputSchema: ingestGitDiffInputSchema,
    },
    async (args) => {
      try {
        const ref = args.ref ?? "HEAD";
        const artifacts = await ingestGitDiff(deps.cas, ref, args.cwd);
        return successResult({ artifacts });
      } catch (error: unknown) {
        return handleToolError(error);
      }
    },
  );

  // --- grove_ingest_git_tree -----------------------------------------------
  server.registerTool(
    "grove_ingest_git_tree",
    {
      description:
        "Enumerate git-tracked files (via `git ls-files`) and ingest each into CAS. " +
        "Returns a map of relative file paths to content hashes. Skips .grove directory " +
        "contents. Reuses the local git-tree ingestion pipeline.",
      inputSchema: ingestGitTreeInputSchema,
    },
    async (args) => {
      try {
        const artifacts = await ingestGitTree(deps.cas, args.cwd);
        return successResult({ artifacts });
      } catch (error: unknown) {
        return handleToolError(error);
      }
    },
  );
}
