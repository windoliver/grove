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
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the MCP serve entry point from the grove installation.
 *
 * @param projectRoot — fallback if no installation path can be derived
 */
export function resolveMcpServePath(projectRoot?: string): string {
  const groveRoots: string[] = [];
  if (process.argv[1]) {
    const entryPoint = pathResolve(process.argv[1]);
    // process.argv[1] = "<groveRoot>/dist/cli/main.js" or "<groveRoot>/src/cli/main.ts"
    // Climb 3 levels: main.js -> cli/ -> dist/ or src/ -> <groveRoot>
    groveRoots.push(dirname(dirname(dirname(entryPoint))));
  }

  // import.meta.url fallback may point to a bundled chunk, but worth trying.
  groveRoots.push(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

  // Try dist first (built install), then src (development)
  const candidates = groveRoots.flatMap((groveRoot) => [
    join(groveRoot, "dist", "mcp", "serve.js"),
    join(groveRoot, "src", "mcp", "serve.ts"),
  ]);

  // Last resort: project root (only works when project IS the grove repo)
  if (projectRoot) {
    candidates.push(join(pathResolve(projectRoot), "src", "mcp", "serve.ts"));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Return best guess even if it doesn't exist — caller will get a clear
  // "file not found" error rather than a confusing empty path
  return candidates[0] ?? "";
}

/**
 * Resolve the bundled skill catalog directory (`<groveRoot>/skills`).
 *
 * In dev and build layouts the catalog lives at the repo root, so no
 * dist/src split is needed — just locate the grove install root.
 *
 * @param projectRoot — fallback if no installation path can be derived
 */
export function resolveBundledSkillsRoot(projectRoot?: string): string {
  const groveRoots: string[] = [];
  if (process.argv[1]) {
    const entryPoint = pathResolve(process.argv[1]);
    // process.argv[1] = "<groveRoot>/dist/cli/main.js" or "<groveRoot>/src/cli/main.ts"
    groveRoots.push(dirname(dirname(dirname(entryPoint))));
  }
  groveRoots.push(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

  const candidates = groveRoots.map((groveRoot) => join(groveRoot, "skills"));
  if (projectRoot) candidates.push(join(pathResolve(projectRoot), "skills"));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0] ?? "";
}
