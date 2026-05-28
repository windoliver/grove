import type { TuiActionRegistryEntry } from "../plugins/registry.js";

/** Built-in action IDs reserved so plugins can't shadow them. */
export function getReservedActionRegistryEntries(): readonly TuiActionRegistryEntry[] {
  return Object.freeze([
    Object.freeze({
      id: "set-goal",
      label: "Set goal",
      detail: "",
      order: 0,
      source: "builtin" as const,
    }),
    Object.freeze({
      id: "register-agent",
      label: "Register agent",
      detail: "",
      order: 10,
      source: "builtin" as const,
    }),
  ]);
}
