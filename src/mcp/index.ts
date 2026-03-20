/**
 * Public API for grove-mcp.
 *
 * Re-exports the server factory, dependency type, and error handler
 * for programmatic usage and testing.
 */

export type { McpDeps } from "./deps.js";
export { handleToolError, McpErrorCode, notFoundError, validationError } from "./error-handler.js";
export type { McpPresetConfig } from "./server.js";
export { createMcpServer } from "./server.js";
