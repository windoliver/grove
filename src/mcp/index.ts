/**
 * Public API for grove-mcp.
 *
 * Re-exports the server factory, dependency type, and error handler
 * for programmatic usage and testing.
 */

export type { AgentInput } from "./agent-identity.js";
export { resolveAgentIdentity } from "./agent-identity.js";
export type { McpDeps } from "./deps.js";
export { handleToolError, McpErrorCode, notFoundError, validationError } from "./error-handler.js";
export { createMcpServer } from "./server.js";
