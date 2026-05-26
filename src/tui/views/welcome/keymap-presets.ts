/**
 * Keymap presets — bundled as JSON imports so the merge works under both
 * `bun run` (source) and the tsup-built output (no filesystem lookup).
 *
 * The first-run UI writes the selected built-in keymap preset name into
 * config.json. The `none` sentinel exists only in the UI layer (no-op; not
 * handled here).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type GroveUserConfig, mergeGroveConfig } from "../../config-loader.js";
import type { KeymapPresetName as BuiltInKeymapPresetName } from "../../keymap/keymap.js";

/** Named keymap preset identifiers bundled with the TUI. */
export type KeymapPresetName = BuiltInKeymapPresetName;

/** Load a bundled keymap preset into a `GroveUserConfig` shape. */
export async function loadKeymapPreset(name: KeymapPresetName): Promise<GroveUserConfig> {
  return {
    theme: {},
    keymap: {},
    keymapPreset: name,
  };
}

/**
 * Apply a preset to a target `config.json` file, merging into any existing
 * content. Used by the first-run wizard to persist the user's chosen
 * keymap preset to `~/.config/grove/config.json`.
 *
 * Corrupted or missing targets are treated as empty. Writes atomically via
 * temp-rename.
 */
export async function applyKeymapPresetToFile(
  name: KeymapPresetName,
  targetPath: string,
): Promise<void> {
  let existing: GroveUserConfig = { theme: {}, keymap: {} };
  try {
    const raw = await readFile(targetPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { theme?: unknown; keymap?: unknown; keymapPreset?: unknown };
      existing = {
        theme: (obj.theme ?? {}) as GroveUserConfig["theme"],
        keymap: (obj.keymap ?? {}) as GroveUserConfig["keymap"],
        keymapPreset: isKeymapPresetName(obj.keymapPreset) ? obj.keymapPreset : undefined,
      };
    }
  } catch (err) {
    if (name === "default" && isErrnoException(err, "ENOENT")) return;
    // Parse errors and non-ENOENT read failures are treated as empty.
  }

  const preset = await loadKeymapPreset(name);
  const merged = mergeGroveConfig(existing, preset);
  const out: {
    readonly theme: GroveUserConfig["theme"];
    readonly keymap: GroveUserConfig["keymap"];
    readonly keymapPreset?: KeymapPresetName | undefined;
  } = {
    theme: merged.theme,
    keymap: merged.keymap,
    keymapPreset: merged.keymapPreset,
  };

  await mkdir(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp`;
  await writeFile(tmp, JSON.stringify(out, null, 2), "utf-8");
  await rename(tmp, targetPath);
}

function isKeymapPresetName(value: unknown): value is KeymapPresetName {
  return value === "default" || value === "power-user";
}

function isErrnoException(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { readonly code?: unknown }).code === code
  );
}
