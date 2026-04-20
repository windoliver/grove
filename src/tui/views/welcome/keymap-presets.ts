/**
 * Keymap presets — bundled as JSON imports so the merge works under both
 * `bun run` (source) and the tsup-built output (no filesystem lookup).
 *
 * Merge semantics reuse `config-loader.ts`'s `mergeGroveConfig`: keymap
 * entries are additive, the existing theme block is preserved verbatim.
 *
 * Two named presets today: `vim` and `emacs`. The `none` sentinel exists
 * only in the UI layer (no-op; not handled here).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import emacsPresetRaw from "../../keymaps/emacs.json" with { type: "json" };
import vimPresetRaw from "../../keymaps/vim.json" with { type: "json" };
import { type GroveUserConfig, mergeGroveConfig } from "../../config-loader.js";

/** Named keymap preset identifiers bundled with the TUI. */
export type KeymapPresetName = "vim" | "emacs";

interface RawPreset {
  readonly keymap: Record<string, string>;
}

const PRESETS: Readonly<Record<KeymapPresetName, RawPreset>> = {
  vim: vimPresetRaw as RawPreset,
  emacs: emacsPresetRaw as RawPreset,
};

/** Load a bundled keymap preset into a `GroveUserConfig` shape. */
export async function loadKeymapPreset(
  name: KeymapPresetName,
): Promise<GroveUserConfig> {
  const preset = PRESETS[name];
  return {
    theme: {},
    keymap: preset.keymap as GroveUserConfig["keymap"],
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
  const preset = await loadKeymapPreset(name);

  let existing: GroveUserConfig = { theme: {}, keymap: {} };
  try {
    const raw = await readFile(targetPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { theme?: unknown; keymap?: unknown };
      existing = {
        theme: (obj.theme ?? {}) as GroveUserConfig["theme"],
        keymap: (obj.keymap ?? {}) as GroveUserConfig["keymap"],
      };
    }
  } catch {
    // ENOENT or parse error — existing stays empty.
  }

  const merged = mergeGroveConfig(existing, preset);
  const out = { theme: merged.theme, keymap: merged.keymap };

  await mkdir(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp`;
  await writeFile(tmp, JSON.stringify(out, null, 2), "utf-8");
  await rename(tmp, targetPath);
}
