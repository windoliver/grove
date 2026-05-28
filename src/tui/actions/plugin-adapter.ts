import type { TuiActionRegistryEntry } from "../plugins/registry.js";
import type { TuiPluginContext } from "../plugins/types.js";
import type { Action, ActionContext } from "./types.js";

/**
 * Wrap plugin action registry entries as unified `Action`s in the Plugins group.
 *
 * `mkPluginCtx` builds the narrow plugin context from the rich one so plugins
 * never receive app internals (panel focus, spawn/kill, dispatch).
 */
export function buildPluginActions(
  entries: readonly TuiActionRegistryEntry[],
  mkPluginCtx: (ctx: ActionContext) => TuiPluginContext,
): readonly Action[] {
  const actions: Action[] = [];
  for (const entry of entries) {
    if (entry.source !== "plugin" || entry.registration === undefined) continue;
    const reg = entry.registration;
    actions.push({
      id: entry.id,
      label: entry.label,
      detail: entry.detail,
      group: "Plugins",
      enabled: reg.enabled ? (ctx) => reg.enabled?.(mkPluginCtx(ctx)) ?? true : undefined,
      run: (ctx) => reg.run(mkPluginCtx(ctx)),
    });
  }
  return Object.freeze(actions);
}
