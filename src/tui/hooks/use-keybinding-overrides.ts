/**
 * Customizable keybindings loader.
 *
 * Loads keybinding overrides from `.grove/keybindings.json`.
 * Format: { "action": "key" } where action is a routeKey action name
 * and key is the key name (e.g., "q", "escape", "tab").
 *
 * Example .grove/keybindings.json:
 * {
 *   "quit": "Q",
 *   "help": "F1",
 *   "zoom_cycle": "z",
 *   "broadcast": "B"
 * }
 *
 * Unknown action names and key conflicts are reported to stderr.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { useEffect, useState } from "react";
import { z } from "zod";

/** Map from action name to custom key binding. */
export type KeybindingOverrides = Readonly<Record<string, string>>;

/** Known action names that can be remapped. */
export const REMAPPABLE_ACTIONS = [
  "quit",
  "help",
  "zoom_cycle",
  "zoom_reset",
  "broadcast",
  "direct_message",
  "search_start",
  "terminal_input",
  "compare_toggle",
  "artifact_prev",
  "artifact_next",
  "artifact_diff",
  "approve",
  "deny",
  "palette",
  "refresh",
] as const;

export type RemappableAction = (typeof REMAPPABLE_ACTIONS)[number];

const KEYBINDINGS_PATH = ".grove/keybindings.json";

/** Zod schema: keybindings file must be a flat string→string map. */
const KeybindingFileSchema = z.record(z.string(), z.string());

/** Load keybinding overrides from disk with validation and conflict reporting. */
export async function loadKeybindings(): Promise<KeybindingOverrides> {
  try {
    const path = resolve(process.cwd(), KEYBINDINGS_PATH);
    const raw = JSON.parse(await readFile(path, "utf-8")) as unknown;

    const parsed = KeybindingFileSchema.safeParse(raw);
    if (!parsed.success) {
      process.stderr.write(`[grove] keybindings.json parse error: ${parsed.error.message}\n`);
      return {};
    }

    const overrides: Record<string, string> = {};
    // Track key → list of actions mapped to it (for conflict detection)
    const keyToActions = new Map<string, string[]>();

    for (const [action, key] of Object.entries(parsed.data)) {
      if (!(REMAPPABLE_ACTIONS as readonly string[]).includes(action)) {
        process.stderr.write(`[grove] keybindings.json: unknown action "${action}" — ignored\n`);
        continue;
      }
      const existing = keyToActions.get(key) ?? [];
      existing.push(action);
      keyToActions.set(key, existing);
      overrides[action] = key;
    }

    // Report conflicts (same key mapped to multiple actions)
    for (const [key, actions] of keyToActions) {
      if (actions.length > 1) {
        process.stderr.write(
          `[grove] keybindings.json: key "${key}" mapped to multiple actions (${actions.join(", ")}) — first wins\n`,
        );
      }
    }

    return overrides;
  } catch {
    return {};
  }
}

/**
 * Build a reverse map: key → action name (for O(1) lookup in routeKey).
 *
 * Uses first-win semantics: if two actions are mapped to the same key,
 * the first one in iteration order wins.
 */
export function buildKeyActionMap(
  overrides: KeybindingOverrides,
): ReadonlyMap<string, RemappableAction> {
  const map = new Map<string, RemappableAction>();
  for (const [action, key] of Object.entries(overrides)) {
    if (!map.has(key)) {
      map.set(key, action as RemappableAction);
    }
  }
  return map;
}

/** Default key → action mappings (used when no override exists). */
export const DEFAULT_KEY_ACTIONS: Readonly<Record<RemappableAction, string>> = {
  quit: "q",
  help: "?",
  zoom_cycle: "+",
  zoom_reset: "escape",
  broadcast: "b",
  direct_message: "@",
  search_start: "/",
  terminal_input: "i",
  compare_toggle: "C",
  artifact_prev: "h",
  artifact_next: "l",
  artifact_diff: "d",
  approve: "a",
  deny: "d",
  palette: "m",
  refresh: "r",
};

/** Hook to load keybinding overrides from .grove/keybindings.json. */
export function useKeybindingOverrides(): KeybindingOverrides {
  const [overrides, setOverrides] = useState<KeybindingOverrides>({});

  useEffect(() => {
    let cancelled = false;
    loadKeybindings().then((loaded) => {
      if (!cancelled) setOverrides(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return overrides;
}
