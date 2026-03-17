/**
 * `grove skill install` command — install SKILL.md into AI assistant skill directories.
 *
 * Reads skill target directories from a config-driven registry (with sensible
 * defaults), generates a SKILL.md from a template, and writes it to each
 * target directory.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { renderSkillTemplate } from "./skill-template.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillTarget {
  platform: string;
  path: string;
}

export interface SkillInstallArgs {
  serverUrl?: string | undefined;
  mcpUrl?: string | undefined;
  targets?: readonly SkillTarget[] | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_URL = "http://localhost:4515";
const DEFAULT_MCP_URL = "http://localhost:4015";

const DEFAULT_SKILL_TARGETS: SkillTarget[] = [
  { platform: "claude-code", path: "~/.claude/skills/grove" },
  { platform: "codex", path: "~/.codex/skills/grove" },
];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseSkillArgs(args: readonly string[]): { subcommand: string; flags: SkillInstallArgs } {
  const subcommand = args[0];
  if (subcommand !== "install") {
    throw new Error(
      subcommand
        ? `Unknown skill subcommand '${subcommand}'. Available: install`
        : "Missing subcommand. Usage: grove skill install [--server-url <url>] [--mcp-url <url>]",
    );
  }

  const { values } = parseArgs({
    args: args.slice(1) as string[],
    options: {
      "server-url": { type: "string" },
      "mcp-url": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  return {
    subcommand,
    flags: {
      serverUrl: values["server-url"] as string | undefined,
      mcpUrl: values["mcp-url"] as string | undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve `~` prefix to the user's home directory. */
function resolvePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Install SKILL.md into each configured skill target directory.
 */
export async function handleSkillInstall(args: SkillInstallArgs): Promise<void> {
  const serverUrl = args.serverUrl ?? DEFAULT_SERVER_URL;
  const mcpUrl = args.mcpUrl ?? DEFAULT_MCP_URL;
  const targets = args.targets ?? DEFAULT_SKILL_TARGETS;

  const content = renderSkillTemplate({ serverUrl, mcpUrl });

  const written: string[] = [];
  for (const target of targets) {
    const dir = resolvePath(target.path);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "SKILL.md");
    await writeFile(filePath, content, "utf-8");
    written.push(filePath);
    console.log(`  ${target.platform}: ${filePath}`);
  }

  console.log(`\nInstalled SKILL.md to ${written.length} target(s).`);
  console.log(`  Server URL: ${serverUrl}`);
  console.log(`  MCP URL:    ${mcpUrl}`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Handle the `grove skill` CLI command.
 */
export async function handleSkill(args: readonly string[]): Promise<void> {
  const { subcommand, flags } = parseSkillArgs(args);

  if (subcommand === "install") {
    await handleSkillInstall(flags);
  }
}
