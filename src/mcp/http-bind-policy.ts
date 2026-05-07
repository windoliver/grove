const LOCALHOST_ADDRESSES = new Set(["localhost", "127.0.0.1", "::1"]);

export interface McpHttpBindPolicyInput {
  readonly host: string | undefined;
  readonly authToken: string | undefined;
  readonly allowRemote: string | undefined;
}

export interface McpHttpBindPolicyResult {
  readonly host: string;
  readonly remote: boolean;
  readonly allowed: boolean;
  readonly reason?: string;
}

export function resolveMcpHttpBindPolicy(input: McpHttpBindPolicyInput): McpHttpBindPolicyResult {
  const host = input.host ?? "localhost";
  const remote = !LOCALHOST_ADDRESSES.has(host);
  if (!remote) return { host, remote, allowed: true };

  if (input.allowRemote !== "true") {
    return {
      host,
      remote,
      allowed: false,
      reason: "remote MCP HTTP binding requires GROVE_MCP_ALLOW_REMOTE=true",
    };
  }

  if (input.authToken === undefined || input.authToken.length === 0) {
    return {
      host,
      remote,
      allowed: false,
      reason: "remote MCP HTTP binding requires GROVE_MCP_AUTH_TOKEN",
    };
  }

  return { host, remote, allowed: true };
}
