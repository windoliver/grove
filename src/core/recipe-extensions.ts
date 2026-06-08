/**
 * Map declarative recipe extensions to launchable MCP server configs.
 *
 * Only `type: mcp` extensions whose URI uses the `stdio:` scheme are wireable
 * through the current stdio-only `AgentConfig.mcpServers` shape. Anything else
 * (non-stdio URIs, or tool/provider/service extensions) is skipped when
 * optional, and is a hard error when `required: true`.
 */

import type { AgentConfig } from "./agent-runtime.js";
import type { RecipeExtension } from "./recipe.js";

type McpServer = NonNullable<AgentConfig["mcpServers"]>[number];

const STDIO_PREFIX = "stdio:";

export function resolveRecipeMcpServers(
  extensions: readonly RecipeExtension[],
): readonly McpServer[] {
  const servers: McpServer[] = [];
  for (const ext of extensions) {
    const stdioServer = tryResolveStdioMcp(ext);
    if (stdioServer !== undefined) {
      servers.push(stdioServer);
      continue;
    }
    if (ext.required === true) {
      throw new Error(
        `extension '${ext.name}' is not launchable: only stdio: MCP URIs are wired today`,
      );
    }
    // Optional and not wireable — warn and skip.
    process.stderr.write(
      `[grove] recipe extension '${ext.name}' (${ext.type}) is not launchable; skipping.\n`,
    );
  }
  return servers;
}

function tryResolveStdioMcp(ext: RecipeExtension): McpServer | undefined {
  if (ext.type !== "mcp" || ext.uri === undefined || !ext.uri.startsWith(STDIO_PREFIX)) {
    return undefined;
  }
  const spec = ext.uri.slice(STDIO_PREFIX.length).trim();
  const parts = spec.split(/\s+/).filter((p) => p.length > 0);
  const command = parts[0];
  if (command === undefined) {
    throw new Error(`extension '${ext.name}' has an empty command in its stdio: URI`);
  }
  return { name: ext.name, command, args: parts.slice(1) };
}
