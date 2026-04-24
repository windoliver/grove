/**
 * User-level project registry: `~/.grove/projects.yaml`.
 *
 * Keyed by the normalized git-origin URL, one entry per logical project.
 * Used by `grove init` to correlate clones of the same remote.
 */

import { homedir } from "node:os";
import { join } from "node:path";

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
