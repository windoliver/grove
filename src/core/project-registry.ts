/**
 * User-level project registry: `~/.grove/projects.yaml`.
 *
 * Keyed by the normalized git-origin URL, one entry per logical project.
 * Used by `grove init` to correlate clones of the same remote.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isValidProjectId } from "./project-id.js";

export interface RegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface Registry {
  readonly version: 1;
  readonly projects: Readonly<Record<string, RegistryEntry>>;
}

export function defaultRegistryPath(): string {
  const home = homedir();
  if (!home) {
    throw new Error("Cannot resolve user home directory for ~/.grove registry.");
  }
  return join(home, ".grove", "projects.yaml");
}

export function loadRegistry(path: string): Registry {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, projects: {} };
    }
    throw err;
  }
  const parsed = parseYaml(raw) as unknown;
  if (parsed == null || typeof parsed !== "object") {
    throw new Error(`Malformed registry at ${path}: expected a YAML mapping.`);
  }
  const root = parsed as Record<string, unknown>;
  if (root.version !== 1) {
    throw new Error(
      `Unknown registry version at ${path}: got ${JSON.stringify(root.version)}, expected 1.`,
    );
  }
  const projectsRaw = root.projects;
  if (projectsRaw == null) {
    return { version: 1, projects: {} };
  }
  if (typeof projectsRaw !== "object") {
    throw new Error(`Malformed registry at ${path}: 'projects' must be a mapping.`);
  }
  const projects: Record<string, RegistryEntry> = {};
  for (const [key, valueRaw] of Object.entries(projectsRaw as Record<string, unknown>)) {
    if (valueRaw == null || typeof valueRaw !== "object") {
      throw new Error(
        `Malformed registry at ${path}: entry '${key}' must be a mapping.`,
      );
    }
    const entry = valueRaw as Record<string, unknown>;
    const id = entry.id;
    const name = entry.name;
    const createdAt = entry.createdAt;
    if (typeof id !== "string" || !isValidProjectId(id)) {
      throw new Error(
        `Invalid registry entry '${key}' at ${path}: id is not a valid UUIDv4.`,
      );
    }
    if (typeof name !== "string" || typeof createdAt !== "string") {
      throw new Error(
        `Invalid registry entry '${key}' at ${path}: name and createdAt must be strings.`,
      );
    }
    projects[key] = { id, name, createdAt };
  }
  return { version: 1, projects };
}

export function saveRegistry(path: string, reg: Registry): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = stringifyYaml(reg);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, path);
}

export function lookupByOrigin(
  reg: Registry,
  origin: string,
): RegistryEntry | null {
  return reg.projects[origin] ?? null;
}

export function upsertEntry(
  reg: Registry,
  origin: string,
  entry: RegistryEntry,
): Registry {
  return {
    version: 1,
    projects: { ...reg.projects, [origin]: entry },
  };
}
