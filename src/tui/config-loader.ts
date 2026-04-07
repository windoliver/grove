/**
 * Grove TUI config loader.
 *
 * Loads user configuration from a layered stack and merges it:
 *
 *   global  (~/.config/grove/config.json)
 *     ↓ project  (.grove/config.json, from groveDir)
 *       ↓ env var  (GROVE_CONFIG — path to an additional override file)
 *
 * Merge semantics:
 *   - theme tokens: last-wins (project overrides global per key)
 *   - keymap:       additive (project entries extend global; project wins on conflict)
 *
 * All layers are optional — missing files are silently skipped.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RemappableAction } from "./hooks/use-keybinding-overrides.js";
import type { ThemeColorTokens } from "./theme.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User-authored grove config (all fields optional — defaults always apply). */
export interface GroveUserConfig {
  readonly theme: Partial<ThemeColorTokens>;
  readonly keymap: Partial<Record<RemappableAction, string>>;
}

/** Empty config — returned when no config files are found. */
export const EMPTY_CONFIG: GroveUserConfig = { theme: {}, keymap: {} };

// ---------------------------------------------------------------------------
// Zod schema (strip unknown keys for forward compat)
// ---------------------------------------------------------------------------

const ConfigSchema = z
  .object({
    theme: z.record(z.string(), z.string()).optional(),
    keymap: z.record(z.string(), z.string()).optional(),
  })
  .strip();

// ---------------------------------------------------------------------------
// Pure merge function (exported for testing — Issue 12A TDD)
// ---------------------------------------------------------------------------

/**
 * Merge two config layers.  `project` wins over `global` for scalar theme
 * tokens; keymap entries are additive (union) with `project` winning on
 * conflict.
 */
export function mergeGroveConfig(
  global: Partial<GroveUserConfig> | undefined,
  project: Partial<GroveUserConfig> | undefined,
): GroveUserConfig {
  return {
    theme: { ...global?.theme, ...project?.theme },
    keymap: { ...global?.keymap, ...project?.keymap },
  };
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

/** Load and validate a single config file. Returns undefined on any error. */
async function loadConfigFile(filePath: string): Promise<Partial<GroveUserConfig> | undefined> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = ConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      process.stderr.write(`[grove] config parse error in ${filePath}: ${parsed.error.message}\n`);
      return undefined;
    }
    return {
      theme: (parsed.data.theme ?? {}) as Partial<ThemeColorTokens>,
      keymap: (parsed.data.keymap ?? {}) as Partial<Record<RemappableAction, string>>,
    };
  } catch {
    // File not found or JSON parse error — gracefully skip
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

/**
 * Load user config from all layers and return the merged result.
 *
 * @param groveDir - Resolved .grove directory path (project-local layer).
 */
export async function loadGroveConfig(groveDir?: string): Promise<GroveUserConfig> {
  const globalPath = join(homedir(), ".config", "grove", "config.json");
  const projectPath = groveDir ? join(groveDir, "config.json") : undefined;
  const envPath = process.env.GROVE_CONFIG;

  const [globalCfg, projectCfg, envCfg] = await Promise.all([
    loadConfigFile(globalPath),
    projectPath !== undefined ? loadConfigFile(projectPath) : Promise.resolve(undefined),
    envPath !== undefined ? loadConfigFile(envPath) : Promise.resolve(undefined),
  ]);

  // Merge order: global → project → env (env is highest priority)
  const base = mergeGroveConfig(globalCfg, projectCfg);
  return mergeGroveConfig(base, envCfg);
}
