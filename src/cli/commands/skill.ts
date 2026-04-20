/**
 * `grove skill install` command — install SKILL.md into AI assistant skill directories.
 *
 * Reads the skill content from the on-disk bundled catalog (default: `skills/`
 * at the grove install root) and writes it to each configured target directory.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillTarget {
  platform: string;
  path: string;
}

export interface SkillInstallArgs {
  targets?: readonly SkillTarget[] | undefined;
  /** Absolute path to the bundled catalog root (defaults to the grove install's `skills/`). */
  catalogRoot?: string | undefined;
}

const DEFAULT_SKILL_TARGETS: SkillTarget[] = [
  { platform: "claude-code", path: "~/.claude/skills/grove" },
  { platform: "codex", path: "~/.codex/skills/grove" },
];

function resolvePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

function defaultCatalogRoot(): string {
  const here = new URL(import.meta.url).pathname;
  // src/cli/commands/skill.ts (dev) OR dist/cli/commands/skill.js (build)
  // → walk up to the install root and append `skills/`.
  return join(here, "..", "..", "..", "..", "skills");
}

export async function handleSkillInstall(args: SkillInstallArgs): Promise<void> {
  const targets = args.targets ?? DEFAULT_SKILL_TARGETS;
  const catalogRoot = args.catalogRoot ?? defaultCatalogRoot();
  const sourcePath = join(catalogRoot, "grove", "SKILL.md");

  let content: string;
  try {
    content = await readFile(sourcePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read bundled skill at ${sourcePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

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
}

export async function handleSkill(args: readonly string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand !== "install") {
    throw new Error(
      subcommand
        ? `Unknown skill subcommand '${subcommand}'. Available: install`
        : "Missing subcommand. Usage: grove skill install",
    );
  }
  await handleSkillInstall({});
}
