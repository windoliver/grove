import type { Panel } from "../hooks/use-panel-focus.js";
import type { TuiPanelRegistration, TuiSlot } from "./types.js";

const DEFAULT_PLUGIN_ORDER = 1000;
const SAFE_PANEL_ID = /^[a-z][a-z0-9.-]*$/;

export interface TuiRegistryEntry {
  readonly id: string;
  readonly label: string;
  readonly slot: TuiSlot;
  readonly order: number;
  readonly source: "builtin" | "plugin";
  readonly builtInPanel?: Panel | undefined;
  readonly registration?: TuiPanelRegistration | undefined;
}

export interface TuiRegistryDiagnostic {
  readonly id: string;
  readonly severity: "error";
  readonly message: string;
}

export interface MergeTuiRegistrationsInput {
  readonly builtIns: readonly TuiRegistryEntry[];
  readonly plugins?: readonly TuiPanelRegistration[] | undefined;
}

export interface MergeTuiRegistrationsResult {
  readonly entries: readonly TuiRegistryEntry[];
  readonly diagnostics: readonly TuiRegistryDiagnostic[];
}

export function isSafeTuiPanelId(id: string): boolean {
  return SAFE_PANEL_ID.test(id);
}

export function mergeTuiRegistrations(
  input: MergeTuiRegistrationsInput,
): MergeTuiRegistrationsResult {
  const entries: TuiRegistryEntry[] = [];
  const diagnostics: TuiRegistryDiagnostic[] = [];
  const seen = new Set<string>();

  for (const entry of input.builtIns) {
    if (!isSafeTuiPanelId(entry.id)) {
      throw new Error(`Built-in TUI panel has invalid id: ${entry.id}`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`Built-in TUI panel id is duplicated: ${entry.id}`);
    }
    seen.add(entry.id);
    entries.push(entry);
  }

  for (const registration of input.plugins ?? []) {
    if (!isSafeTuiPanelId(registration.id)) {
      diagnostics.push({
        id: registration.id,
        severity: "error",
        message: `Invalid TUI panel id: ${registration.id}`,
      });
      continue;
    }
    if (seen.has(registration.id)) {
      diagnostics.push({
        id: registration.id,
        severity: "error",
        message: `Duplicate TUI panel id: ${registration.id}`,
      });
      continue;
    }
    seen.add(registration.id);
    entries.push({
      id: registration.id,
      label: registration.label,
      slot: registration.slot,
      order: registration.order ?? DEFAULT_PLUGIN_ORDER,
      source: "plugin",
      registration,
    });
  }

  entries.sort((a, b) => {
    const orderDelta = a.order - b.order;
    if (orderDelta !== 0) return orderDelta;
    const sourceDelta = sourceRank(a.source) - sourceRank(b.source);
    if (sourceDelta !== 0) return sourceDelta;
    return a.id.localeCompare(b.id);
  });

  return {
    entries: Object.freeze(entries),
    diagnostics: Object.freeze(diagnostics),
  };
}

function sourceRank(source: "builtin" | "plugin"): number {
  return source === "builtin" ? 0 : 1;
}
