/**
 * Alias file loader: reads <groveDir>/.grove/aliases.yaml and
 * ~/.grove/aliases.yaml, validates with zod, merges over DEFAULT_ALIASES.
 * Project file wins on key conflicts.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type AliasEntry, type AliasMap, DEFAULT_ALIASES } from "./aliases.js";

const AliasFileSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]*$/), z.string().min(1));

export interface LoadResult {
  readonly aliases: AliasMap;
  readonly errors: readonly string[];
}

export interface LoadOptions {
  /** Override $HOME — for tests. */
  readonly homeOverride?: string | undefined;
}

interface FileResult {
  readonly map: ReadonlyMap<string, AliasEntry>;
  readonly errors: readonly string[];
}

async function readOne(path: string): Promise<FileResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { map: new Map(), errors: [] };
    return { map: new Map(), errors: [`${path}: ${e.message}`] };
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { map: new Map(), errors: [`${path}: parse error — ${(err as Error).message}`] };
  }
  if (raw === null || raw === undefined) {
    return { map: new Map(), errors: [] };
  }
  const parsed = AliasFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      map: new Map(),
      errors: [`${path}: schema error — ${parsed.error.message}`],
    };
  }
  const map = new Map<string, AliasEntry>();
  for (const [k, v] of Object.entries(parsed.data)) map.set(k, { value: v });
  return { map, errors: [] };
}

export async function loadAliases(
  groveDir: string,
  options: LoadOptions = {},
): Promise<LoadResult> {
  const home = options.homeOverride ?? homedir();
  const userPath = join(home, ".grove", "aliases.yaml");
  const projectPath = join(groveDir, ".grove", "aliases.yaml");
  const [user, project] = await Promise.all([readOne(userPath), readOne(projectPath)]);
  const merged = new Map<string, AliasEntry>(DEFAULT_ALIASES);
  for (const [k, v] of user.map) merged.set(k, v);
  for (const [k, v] of project.map) merged.set(k, v); // project wins
  return {
    aliases: merged,
    errors: [...user.errors, ...project.errors],
  };
}
