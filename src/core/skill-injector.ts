/**
 * skill-injector — resolve named skills against a two-layer catalog
 * (workspace override first, bundled default second) and recursive-copy
 * each resolved directory into the workspace's Claude and Codex native
 * skill paths.
 *
 * Pure module: no Nexus, no network, no runtime templating.
 */

import { chmod, cp, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface SkillInjectionOptions {
  /** Absolute path to the agent workspace directory. */
  workspacePath: string;
  /** Skill names to inject (from topology role). */
  skills: readonly string[];
  /** Absolute path to the bundled catalog (grove repo's top-level `skills/`). */
  bundledSkillsRoot: string;
  /** Optional absolute path to workspace-specific overrides. */
  workspaceOverrideRoot?: string | undefined;
}

export interface InjectedSkill {
  readonly name: string;
  readonly source: "override" | "bundled";
  readonly sourcePath: string;
  readonly targets: readonly string[];
}

export interface InjectionReport {
  readonly injected: readonly InjectedSkill[];
}

export class SkillResolutionError extends Error {
  readonly skillName: string;
  readonly searchedPaths: readonly string[];
  constructor(skillName: string, searchedPaths: readonly string[]) {
    super(`Skill '${skillName}' not found. Searched: ${searchedPaths.join(", ")}`);
    this.name = "SkillResolutionError";
    this.skillName = skillName;
    this.searchedPaths = searchedPaths;
  }
}

const CLAUDE_SUBPATH = ".claude/skills";
const CODEX_SUBPATH = ".codex/skills";

async function isDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

interface Resolved {
  name: string;
  source: "override" | "bundled";
  sourcePath: string;
}

async function resolveSkill(
  name: string,
  bundledRoot: string,
  overrideRoot: string | undefined,
): Promise<Resolved> {
  const searched: string[] = [];

  if (overrideRoot) {
    const overridePath = join(overrideRoot, name);
    searched.push(overridePath);
    if ((await isDir(overridePath)) && (await isFile(join(overridePath, "SKILL.md")))) {
      return { name, source: "override", sourcePath: overridePath };
    }
  }

  const bundledPath = join(bundledRoot, name);
  searched.push(bundledPath);
  if ((await isDir(bundledPath)) && (await isFile(join(bundledPath, "SKILL.md")))) {
    return { name, source: "bundled", sourcePath: bundledPath };
  }

  throw new SkillResolutionError(name, searched);
}

async function copyDir(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function chmodTree(root: string, mode: number): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await chmodTree(full, mode);
    } else {
      await chmod(full, mode).catch(() => undefined);
    }
  }
}

export async function injectSkills(opts: SkillInjectionOptions): Promise<InjectionReport> {
  if (opts.skills.length === 0) {
    return { injected: [] };
  }

  const overrideExists = opts.workspaceOverrideRoot
    ? await isDir(opts.workspaceOverrideRoot)
    : false;
  const effectiveOverride = overrideExists ? opts.workspaceOverrideRoot : undefined;

  const resolved: Resolved[] = [];
  for (const name of opts.skills) {
    resolved.push(await resolveSkill(name, opts.bundledSkillsRoot, effectiveOverride));
  }

  const injected: InjectedSkill[] = [];
  for (const r of resolved) {
    const claudeTarget = join(opts.workspacePath, CLAUDE_SUBPATH, r.name);
    const codexTarget = join(opts.workspacePath, CODEX_SUBPATH, r.name);

    await copyDir(r.sourcePath, claudeTarget);
    await copyDir(r.sourcePath, codexTarget);
    await chmodTree(claudeTarget, 0o444);
    await chmodTree(codexTarget, 0o444);

    injected.push({
      name: r.name,
      source: r.source,
      sourcePath: r.sourcePath,
      targets: [claudeTarget, codexTarget],
    });
  }

  return { injected };
}
