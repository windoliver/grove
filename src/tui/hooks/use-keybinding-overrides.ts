/**
 * Customizable keybindings loader.
 *
 * Loads keybinding overrides from `.grove/keybindings.json`.
 * Format: { "action": "sequence" } where action is a keymap binding id
 * and sequence is a key sequence (e.g., "Q", "Space p t", "F5").
 *
 * Example .grove/keybindings.json:
 * {
 *   "quit": "Space x",
 *   "help": "F1",
 *   "toggle_panel:terminal": "Space p x",
 *   "broadcast": "B"
 * }
 *
 * Unknown action names and key conflicts are reported to stderr.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
  isKeyBindingId,
  KEY_BINDING_IDS,
  type KeyBindingId,
  type KeymapOverrides,
} from "../keymap/keymap.js";

/** Map from action name to custom key binding. */
export type KeybindingOverrides = KeymapOverrides;

export type RemappableAction = KeyBindingId;

/** Known action names that can be remapped. */
export const REMAPPABLE_ACTIONS: readonly RemappableAction[] = KEY_BINDING_IDS;

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
      if (!isKeyBindingId(action)) {
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
