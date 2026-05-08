export interface McpHttpListenOptions {
  readonly host?: string | undefined;
  readonly authToken?: string | undefined;
}

export interface ResolvedMcpHttpListenOptions {
  readonly host: string;
}

const DEFAULT_MCP_HTTP_HOST = "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export function resolveMcpHttpListenOptions(
  options: McpHttpListenOptions,
): ResolvedMcpHttpListenOptions {
  const host = normalizeHost(options.host);
  if (!isLoopbackHost(host) && isBlank(options.authToken)) {
    throw new Error(
      `GROVE_MCP_AUTH_TOKEN is required when grove-mcp-http binds to non-local host ${host}`,
    );
  }
  return { host };
}

function normalizeHost(host: string | undefined): string {
  const trimmed = host?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : DEFAULT_MCP_HTTP_HOST;
}

function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (WILDCARD_HOSTS.has(host)) return false;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}
