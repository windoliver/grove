import type { TuiRegistryEntry } from "../plugins/registry.js";

export function getDefaultVisiblePluginPanelEntries(
  entries: readonly TuiRegistryEntry[],
): readonly TuiRegistryEntry[] {
  return Object.freeze(
    entries.filter(
      (entry) =>
        entry.source === "plugin" &&
        entry.slot === "operator-panel" &&
        entry.registration !== undefined &&
        entry.registration.defaultVisible === true,
    ),
  );
}
