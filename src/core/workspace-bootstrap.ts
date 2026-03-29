/**
 * Shared workspace bootstrap — writes .mcp.json and CLAUDE.md into agent workspaces.
 *
 * Used by both SpawnManager (TUI path) and SessionOrchestrator (headless/server path).
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BootstrapOptions {
  /** Path to the agent workspace directory. */
  workspacePath: string;
  /** Role ID (coder, reviewer, etc.). */
  roleId: string;
  /** Session goal. */
  goal?: string;
  /** Role prompt from topology. */
  rolePrompt?: string | undefined;
  /** Role description from topology. */
  roleDescription?: string | undefined;
  /** Path to the .grove directory. */
  groveDir?: string | undefined;
  /** Path to MCP serve.ts entry point. */
  mcpServePath?: string | undefined;
  /** Nexus URL for MCP env. */
  nexusUrl?: string | undefined;
  /** Nexus API key for MCP env. */
  nexusApiKey?: string | undefined;
}

/**
 * Bootstrap an agent workspace with .mcp.json and CLAUDE.md.
 * Makes config files read-only to prevent agent mutation.
 */
export async function bootstrapWorkspace(opts: BootstrapOptions): Promise<void> {
  const { workspacePath, roleId } = opts;

  // Write .mcp.json
  if (opts.mcpServePath && opts.groveDir) {
    const mcpEnv: Record<string, string> = { GROVE_DIR: opts.groveDir };
    if (opts.nexusUrl) mcpEnv.GROVE_NEXUS_URL = opts.nexusUrl;
    if (opts.nexusApiKey) mcpEnv.NEXUS_API_KEY = opts.nexusApiKey;
    if (roleId) mcpEnv.GROVE_AGENT_ROLE = roleId;

    const mcpConfig = {
      mcpServers: {
        grove: {
          command: "bun",
          args: ["run", opts.mcpServePath],
          env: mcpEnv,
        },
      },
    };
    await writeFile(join(workspacePath, ".mcp.json"), JSON.stringify(mcpConfig, null, 2), "utf-8");
  }

  // Write CLAUDE.md / CODEX.md
  const goal = opts.goal || opts.rolePrompt || "Follow your role instructions.";
  const instructions = `# Grove Agent: ${roleId}

## Session Goal
${goal}

## Your Role: ${roleId}
${opts.roleDescription ?? ""}

${opts.rolePrompt ? `## Instructions\n${opts.rolePrompt}\n` : ""}

## Identity

You are the **${roleId}** agent. Always pass \`agent: { role: "${roleId}" }\` in all grove tool calls.

## Communication

You will receive push notifications when other agents produce work. Do NOT poll.

## MCP Tools (use sparingly)

- \`grove_submit_work\` — record work with artifacts (always include agent: { role: "${roleId}" })
- \`grove_submit_review\` — review another agent's work with scores (always include agent: { role: "${roleId}" })
- \`grove_done\` — signal session complete (only after approval from other agents)

Follow the Instructions section above exactly. You can edit files, commit, push, create PRs, and use gh CLI.
`;

  await writeFile(join(workspacePath, "CLAUDE.md"), instructions, "utf-8");
  await writeFile(join(workspacePath, "CODEX.md"), instructions, "utf-8");

  // Write .grove context dir
  const contextDir = join(workspacePath, ".grove");
  await mkdir(contextDir, { recursive: true });

  // Protect config files from agent mutation
  for (const f of [".mcp.json", "CLAUDE.md", "CODEX.md"]) {
    await chmod(join(workspacePath, f), 0o444).catch(() => {
      // File may not exist
    });
  }
}
