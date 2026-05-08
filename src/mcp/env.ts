import { readFileSync } from "node:fs";
import { join } from "node:path";

interface WorkspaceMcpConfig {
  readonly mcpServers?: {
    readonly grove?: {
      readonly env?: {
        readonly NEXUS_API_KEY?: unknown;
      };
    };
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function resolveNexusApiKey(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = nonEmptyString(env.NEXUS_API_KEY);
  if (fromEnv !== undefined) return fromEnv;

  try {
    const config = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf-8")) as WorkspaceMcpConfig;
    return nonEmptyString(config.mcpServers?.grove?.env?.NEXUS_API_KEY);
  } catch {
    return undefined;
  }
}
