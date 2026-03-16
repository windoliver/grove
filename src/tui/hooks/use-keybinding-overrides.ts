/**
 * Customizable keybindings loader (item 19).
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
 */

import { useEffect, useState } from "react";

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

/** Load keybinding overrides from disk. */
async function loadKeybindings(): Promise<KeybindingOverrides> {
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const path = resolve(process.cwd(), KEYBINDINGS_PATH);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;

    const overrides: Record<string, string> = {};
    for (const [action, key] of Object.entries(raw)) {
      if (typeof key === "string" && (REMAPPABLE_ACTIONS as readonly string[]).includes(action)) {
        overrides[action] = key;
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

/** Build a reverse map: key → action name (for quick lookup in routeKey). */
export function buildKeyActionMap(
  overrides: KeybindingOverrides,
): ReadonlyMap<string, RemappableAction> {
  const map = new Map<string, RemappableAction>();
  for (const [action, key] of Object.entries(overrides)) {
    map.set(key, action as RemappableAction);
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
