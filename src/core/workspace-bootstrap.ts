/**
 * Shared workspace bootstrap — writes .mcp.json and CLAUDE.md into agent workspaces.
 *
 * Used by both SpawnManager (TUI path) and SessionOrchestrator (headless/server path).
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { injectSkills } from "./skill-injector.js";

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
  /** Skill names to inject. If empty or omitted, no injection happens. */
  skills?: readonly string[] | undefined;
  /** Absolute path to the bundled catalog; required when `skills` is non-empty. */
  bundledSkillsRoot?: string | undefined;
  /** Optional absolute path to the workspace-specific override catalog. */
  workspaceOverrideRoot?: string | undefined;
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

    // Write .acpxrc.json — acpx (>=0.5.3) reads THIS, not .mcp.json.
    // Without it, acpx launches agents with mcpServers=[] and grove_* tools
    // are unavailable. Format: array of servers with name/type/command/args/env.
    const acpxRcConfig = {
      mcpServers: [
        {
          name: "grove",
          type: "stdio",
          command: "bun",
          args: ["run", opts.mcpServePath],
          env: Object.entries(mcpEnv).map(([name, value]) => ({ name, value })),
        },
      ],
    };
    await writeFile(
      join(workspacePath, ".acpxrc.json"),
      JSON.stringify(acpxRcConfig, null, 2),
      "utf-8",
    );
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
When you receive a notification with a source branch, run \`git merge <branch>\` to see the actual file changes in your workspace.

## MCP Tools

- \`grove_submit_work\` — submit your work. Pass commitHash (git commit SHA) so others can see your files.
- \`grove_submit_review\` — review another agent's work. Requires targetCid from the notification.
- \`grove_done\` — signal session complete. Only call when work is approved.

## Workflow

**Submitting work (coder):**
1. Edit files in your workspace
2. \`git add -A && git commit -m "description"\`
3. Get the commit hash: \`git rev-parse HEAD\`
4. \`grove_submit_work({ summary: "...", commitHash: "<hash>", agent: { role: "${roleId}" } })\`

**Reviewing work (reviewer):**
1. When notified: the notification includes a **Workspace** path — read the source files directly from that path
2. Example: \`cat /path/to/coder-workspace/app.js\` to see the actual code
3. Review the code for bugs, correctness, quality
4. \`grove_submit_review({ targetCid: "<cid from notification>", summary: "...", scores: {"correctness": {"value": 0.9, "direction": "maximize"}}, agent: { role: "${roleId}" } })\`
5. If approved: \`grove_done({ summary: "Approved", agent: { role: "${roleId}" } })\`

Follow the Instructions section above exactly. You can edit files, commit, push, create PRs, and use gh CLI.
`;

  await writeFile(join(workspacePath, "CLAUDE.md"), instructions, "utf-8");
  await writeFile(join(workspacePath, "CODEX.md"), instructions, "utf-8");

  // Write .grove context dir
  const contextDir = join(workspacePath, ".grove");
  await mkdir(contextDir, { recursive: true });

  // Inject skills (optional). injectSkills applies its own 0o444 pass, so
  // the following chmod loop does not need to cover the injected tree.
  if (opts.skills && opts.skills.length > 0) {
    if (!opts.bundledSkillsRoot) {
      throw new Error(
        "bootstrapWorkspace: `skills` non-empty requires `bundledSkillsRoot` — refusing to inject with no catalog.",
      );
    }
    await injectSkills({
      workspacePath: workspacePath,
      skills: opts.skills,
      bundledSkillsRoot: opts.bundledSkillsRoot,
      workspaceOverrideRoot: opts.workspaceOverrideRoot,
    });
  }

  // Protect config files from agent mutation
  for (const f of [".mcp.json", ".acpxrc.json", "CLAUDE.md", "CODEX.md"]) {
    await chmod(join(workspacePath, f), 0o444).catch(() => {
      // File may not exist
    });
  }
}
