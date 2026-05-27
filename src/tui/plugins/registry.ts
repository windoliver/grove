import type { Panel } from "../hooks/use-panel-focus.js";
import type {
  TuiActionRegistration,
  TuiExtension,
  TuiPanelRegistration,
  TuiSlot,
} from "./types.js";

const DEFAULT_PLUGIN_ORDER = 1000;
const SAFE_TUI_ID = /^[a-z][a-z0-9.-]*$/;

export interface TuiRegistryEntry {
  readonly id: string;
  readonly label: string;
  readonly slot: TuiSlot;
  readonly order: number;
  readonly source: "builtin" | "plugin";
  readonly builtInPanel?: Panel | undefined;
  readonly registration?: TuiPanelRegistration | undefined;
}

export interface TuiActionRegistryEntry {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly order: number;
  readonly source: "builtin" | "plugin";
  readonly builtInAction?: string | undefined;
  readonly registration?: TuiActionRegistration | undefined;
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

export interface MergeTuiActionRegistrationsInput {
  readonly builtIns: readonly TuiActionRegistryEntry[];
  readonly plugins?: readonly TuiActionRegistration[] | undefined;
}

export interface MergeTuiActionRegistrationsResult {
  readonly entries: readonly TuiActionRegistryEntry[];
  readonly diagnostics: readonly TuiRegistryDiagnostic[];
}

export function isSafeTuiId(id: string): boolean {
  return SAFE_TUI_ID.test(id);
}

export function isSafeTuiPanelId(id: string): boolean {
  return isSafeTuiId(id);
}

export function collectTuiPanelRegistrations(
  extensions?: readonly TuiExtension[] | undefined,
): readonly TuiPanelRegistration[] {
  const registrations = (extensions ?? []).flatMap((extension) => extension.panels ?? []);
  return Object.freeze(registrations);
}

export function collectTuiActionRegistrations(
  extensions?: readonly TuiExtension[] | undefined,
): readonly TuiActionRegistration[] {
  const registrations = (extensions ?? []).flatMap((extension) => extension.actions ?? []);
  return Object.freeze(registrations);
}

export function mergeTuiRegistrations(
  input: MergeTuiRegistrationsInput,
): MergeTuiRegistrationsResult {
  const entries: TuiRegistryEntry[] = [];
  const diagnostics: TuiRegistryDiagnostic[] = [];
  const seen = new Set<string>();

  for (const entry of input.builtIns) {
    if (!isSafeTuiId(entry.id)) {
      throw new Error(`Built-in TUI panel has invalid id: ${entry.id}`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`Built-in TUI panel id is duplicated: ${entry.id}`);
    }
    seen.add(entry.id);
    entries.push(entry);
  }

  for (const registration of input.plugins ?? []) {
    if (!isSafeTuiId(registration.id)) {
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
    const order = resolvePluginOrder(registration.id, registration.order, "panel", diagnostics);
    entries.push({
      id: registration.id,
      label: registration.label,
      slot: registration.slot,
      order,
      source: "plugin",
      registration,
    });
  }

  entries.sort(compareRegistryEntries);

  return {
    entries: Object.freeze(entries),
    diagnostics: Object.freeze(diagnostics),
  };
}

export function mergeTuiActionRegistrations(
  input: MergeTuiActionRegistrationsInput,
): MergeTuiActionRegistrationsResult {
  const entries: TuiActionRegistryEntry[] = [];
  const diagnostics: TuiRegistryDiagnostic[] = [];
  const seen = new Set<string>();

  for (const entry of input.builtIns) {
    if (!isSafeTuiId(entry.id)) {
      throw new Error(`Built-in TUI action has invalid id: ${entry.id}`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`Built-in TUI action id is duplicated: ${entry.id}`);
    }
    seen.add(entry.id);
    entries.push(entry);
  }

  for (const registration of input.plugins ?? []) {
    if (!isSafeTuiId(registration.id)) {
      diagnostics.push({
        id: registration.id,
        severity: "error",
        message: `Invalid TUI action id: ${registration.id}`,
      });
      continue;
    }
    if (seen.has(registration.id)) {
      diagnostics.push({
        id: registration.id,
        severity: "error",
        message: `Duplicate TUI action id: ${registration.id}`,
      });
      continue;
    }
    seen.add(registration.id);
    const order = resolvePluginOrder(registration.id, registration.order, "action", diagnostics);
    entries.push({
      id: registration.id,
      label: registration.label,
      detail: registration.detail,
      order,
      source: "plugin",
      registration,
    });
  }

  entries.sort(compareRegistryEntries);

  return {
    entries: Object.freeze(entries),
    diagnostics: Object.freeze(diagnostics),
  };
}

function compareRegistryEntries(
  a: Pick<TuiRegistryEntry, "id" | "order" | "source">,
  b: Pick<TuiRegistryEntry, "id" | "order" | "source">,
): number {
  const orderDelta = a.order - b.order;
  if (orderDelta !== 0) return orderDelta;
  const sourceDelta = sourceRank(a.source) - sourceRank(b.source);
  if (sourceDelta !== 0) return sourceDelta;
  return a.id.localeCompare(b.id);
}

function sourceRank(source: "builtin" | "plugin"): number {
  return source === "builtin" ? 0 : 1;
}

function resolvePluginOrder(
  id: string,
  order: number | undefined,
  kind: "action" | "panel",
  diagnostics: TuiRegistryDiagnostic[],
): number {
  if (order === undefined) return DEFAULT_PLUGIN_ORDER;
  if (Number.isFinite(order)) return order;

  diagnostics.push({
    id,
    severity: "error",
    message: `Invalid TUI ${kind} order for ${id}; using default order ${DEFAULT_PLUGIN_ORDER}`,
  });
  return DEFAULT_PLUGIN_ORDER;
}
