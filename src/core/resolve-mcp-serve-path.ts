/**
 * Resolves the path to the grove MCP server entry point.
 *
 * The MCP server lives in the grove installation directory (dist/mcp/serve.js
 * for built installs, src/mcp/serve.ts for development). It does NOT live in
 * the user's project directory.
 *
 * Resolution order:
 *   1. process.argv[1] → climb 3 levels → dist/mcp/serve.js
 *   2. process.argv[1] → climb 3 levels �� src/mcp/serve.ts
 *   3. import.meta.url  → climb 3 levels → dist/mcp/serve.js
 *   4. import.meta.url  → climb 3 levels → src/mcp/serve.ts
 *   5. fallback: projectRoot/src/mcp/serve.ts (last resort)
 *
 * Used by both SpawnManager (TUI) and SessionOrchestrator (headless).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolve the MCP serve entry point from the grove installation.
 *
 * @param projectRoot — fallback if no installation path can be derived
 */
export function resolveMcpServePath(projectRoot?: string): string {
  const entryPoint = process.argv[1] ?? "";
  // process.argv[1] = "<groveRoot>/dist/cli/main.js" or "<groveRoot>/src/cli/main.ts"
  // Climb 3 levels: main.js → cli/ → dist/ or src/ → <groveRoot>
  const groveRootFromEntry = dirname(dirname(dirname(entryPoint)));

  // import.meta.url fallback — may point to a bundled chunk, but worth trying
  const groveRootFromMeta = dirname(dirname(dirname(new URL(import.meta.url).pathname)));

  // Try dist first (built install), then src (development)
  const candidates = [
    join(groveRootFromEntry, "dist", "mcp", "serve.js"),
    join(groveRootFromEntry, "src", "mcp", "serve.ts"),
    join(groveRootFromMeta, "dist", "mcp", "serve.js"),
    join(groveRootFromMeta, "src", "mcp", "serve.ts"),
  ];

  // Last resort: project root (only works when project IS the grove repo)
  if (projectRoot) {
    candidates.push(join(projectRoot, "src", "mcp", "serve.ts"));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Return best guess even if it doesn't exist — caller will get a clear
  // "file not found" error rather than a confusing empty path
  return candidates[0]!;
}
