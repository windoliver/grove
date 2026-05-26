import type { TuiRegistryEntry } from "../plugins/registry.js";
import type { LayoutMode, ZoomLevel } from "./panel-registry.js";

export interface ShouldRenderDefaultVisiblePluginPanelsInput {
  readonly layoutMode: LayoutMode;
  readonly zoomLevel: ZoomLevel;
  readonly isMedium: boolean;
}

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

export function shouldRenderDefaultVisiblePluginPanels({
  layoutMode,
  zoomLevel,
  isMedium,
}: ShouldRenderDefaultVisiblePluginPanelsInput): boolean {
  return layoutMode === "grid" && zoomLevel !== "full" && !isMedium;
}
