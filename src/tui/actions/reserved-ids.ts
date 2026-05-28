import type { TuiActionRegistryEntry } from "../plugins/registry.js";

/**
 * Built-in action IDs reserved so plugins can't shadow them. These mirror the
 * ids produced by `buildBuiltInActions` (see `builtin-actions.ts`) for the
 * workflow actions a plugin is most likely to collide with.
 */
export function getReservedActionRegistryEntries(): readonly TuiActionRegistryEntry[] {
  return Object.freeze([
    Object.freeze({
      id: "workflow.set-goal",
      label: "Set goal",
      detail: "",
      order: 0,
      source: "builtin" as const,
    }),
    Object.freeze({
      id: "workflow.register-agent",
      label: "Register agent",
      detail: "",
      order: 10,
      source: "builtin" as const,
    }),
  ]);
}
