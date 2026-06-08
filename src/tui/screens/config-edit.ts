/**
 * Pure config-editing helpers for the ConfigReview screen (#201).
 *
 * The ConfigReview component is a thin view + keyboard dispatch over these
 * pure functions, which hold all validation/immutability logic so they can be
 * unit-tested without a TUI renderer (mirrors the agent-detect helper pattern).
 *
 * Editable surface (Tasks-faithful scope, issue #201):
 *   - mode: evaluation <-> exploration
 *   - stopConditions: maxRoundsWithoutImprovement, budget.maxContributions,
 *     budget.maxWallClockSeconds, targetMetric.value (when a target metric exists)
 *   - concurrency: maxActiveClaims, maxClaimsPerAgent
 *
 * Every other contract section is read-only and is never mutated here.
 */

import type {
  Budget,
  ConcurrencyConfig,
  GroveContract,
  StopConditions,
} from "../../core/contract.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Identifiers for the editable fields, in display order. */
export type EditableFieldId =
  | "mode"
  | "stop.maxRoundsWithoutImprovement"
  | "stop.targetMetric.value"
  | "stop.budget.maxContributions"
  | "stop.budget.maxWallClockSeconds"
  | "concurrency.maxActiveClaims"
  | "concurrency.maxClaimsPerAgent";

type NumericFieldId = Exclude<EditableFieldId, "mode">;

/** Numeric validation bounds. Keep in sync with src/core/contract.ts Zod schemas. */
interface NumericBounds {
  readonly min?: number;
  readonly max?: number;
  readonly integer: boolean;
  /** When true, empty input is rejected instead of unsetting the field. */
  readonly required: boolean;
}

/** A single editable field, resolved against the current draft. */
export interface EditableField {
  readonly id: EditableFieldId;
  readonly label: string;
  readonly kind: "enum" | "number";
  /** Display string for the current value (e.g. "evaluation", "200", "(unset)"). */
  readonly display: string;
  readonly bounds?: NumericBounds | undefined;
}

const NUMERIC_BOUNDS: Readonly<Record<NumericFieldId, NumericBounds>> = {
  "stop.maxRoundsWithoutImprovement": { min: 1, max: 1000, integer: true, required: false },
  "stop.targetMetric.value": { integer: false, required: true },
  "stop.budget.maxContributions": { min: 1, integer: true, required: false },
  "stop.budget.maxWallClockSeconds": { min: 1, integer: true, required: false },
  "concurrency.maxActiveClaims": { min: 1, max: 1000, integer: true, required: false },
  "concurrency.maxClaimsPerAgent": { min: 0, max: 100, integer: true, required: false },
};

function fmt(value: number | undefined): string {
  return value === undefined ? "(unset)" : String(value);
}

/**
 * Resolve the ordered list of editable fields against a draft contract.
 * `stop.targetMetric.value` only appears when a target metric is defined — a
 * value without a metric is meaningless and invalid per the schema.
 */
export function getEditableFields(config: GroveContract): readonly EditableField[] {
  const stop = config.stopConditions;
  const conc = config.concurrency;
  const fields: EditableField[] = [
    { id: "mode", label: "Mode", kind: "enum", display: config.mode ?? "(unset)" },
    {
      id: "stop.maxRoundsWithoutImprovement",
      label: "Stop: max rounds without improvement",
      kind: "number",
      display: fmt(stop?.maxRoundsWithoutImprovement),
      bounds: NUMERIC_BOUNDS["stop.maxRoundsWithoutImprovement"],
    },
  ];
  if (stop?.targetMetric?.metric !== undefined) {
    fields.push({
      id: "stop.targetMetric.value",
      label: `Stop: target ${stop.targetMetric.metric}`,
      kind: "number",
      display: fmt(stop.targetMetric.value),
      bounds: NUMERIC_BOUNDS["stop.targetMetric.value"],
    });
  }
  fields.push(
    {
      id: "stop.budget.maxContributions",
      label: "Stop: budget max contributions",
      kind: "number",
      display: fmt(stop?.budget?.maxContributions),
      bounds: NUMERIC_BOUNDS["stop.budget.maxContributions"],
    },
    {
      id: "stop.budget.maxWallClockSeconds",
      label: "Stop: budget max wall-clock (s)",
      kind: "number",
      display: fmt(stop?.budget?.maxWallClockSeconds),
      bounds: NUMERIC_BOUNDS["stop.budget.maxWallClockSeconds"],
    },
    {
      id: "concurrency.maxActiveClaims",
      label: "Concurrency: max active claims",
      kind: "number",
      display: fmt(conc?.maxActiveClaims),
      bounds: NUMERIC_BOUNDS["concurrency.maxActiveClaims"],
    },
    {
      id: "concurrency.maxClaimsPerAgent",
      label: "Concurrency: max claims per agent",
      kind: "number",
      display: fmt(conc?.maxClaimsPerAgent),
      bounds: NUMERIC_BOUNDS["concurrency.maxClaimsPerAgent"],
    },
  );
  return fields;
}

/** Toggle mode evaluation <-> exploration (undefined becomes "evaluation"). */
export function toggleMode(config: GroveContract): GroveContract {
  return { ...config, mode: config.mode === "evaluation" ? "exploration" : "evaluation" };
}

/** Result of a numeric edit: the (possibly unchanged) config plus an optional error. */
export interface FieldEditResult {
  readonly config: GroveContract;
  readonly error?: string | undefined;
}

/** Parse a strict base-10 integer; undefined if the string isn't a clean integer. */
function parseInteger(s: string): number | undefined {
  if (!/^-?\d+$/.test(s)) return undefined;
  return Number.parseInt(s, 10);
}

function hasAnyKey(obj: object): boolean {
  return Object.keys(obj).length > 0;
}

function assign<T, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete obj[key];
  else obj[key] = value;
}

/**
 * Apply a raw string edit to a numeric field. Returns the updated config, or
 * the original config plus an `error` message when validation fails.
 *
 * Empty input unsets an optional field; `required` fields (targetMetric.value)
 * reject empty. Clearing both budget sub-fields drops the budget object so the
 * contract never carries an empty budget (its Zod refine rejects that).
 */
export function setNumericField(
  config: GroveContract,
  id: EditableFieldId,
  raw: string,
): FieldEditResult {
  if (id === "mode") return { config };
  const bounds = NUMERIC_BOUNDS[id];
  const trimmed = raw.trim();

  let value: number | undefined;
  if (trimmed === "") {
    if (bounds.required) return { config, error: "value is required" };
    value = undefined;
  } else {
    const parsed = bounds.integer ? parseInteger(trimmed) : Number(trimmed);
    if (parsed === undefined || !Number.isFinite(parsed)) {
      return { config, error: bounds.integer ? "must be a whole number" : "must be a number" };
    }
    if (bounds.min !== undefined && parsed < bounds.min) {
      return { config, error: `must be ≥ ${bounds.min}` };
    }
    if (bounds.max !== undefined && parsed > bounds.max) {
      return { config, error: `must be ≤ ${bounds.max}` };
    }
    value = parsed;
  }

  const stop = structuredClone(config.stopConditions ?? {}) as Mutable<StopConditions>;
  const conc = structuredClone(config.concurrency ?? {}) as Mutable<ConcurrencyConfig>;

  switch (id) {
    case "stop.maxRoundsWithoutImprovement":
      assign(stop, "maxRoundsWithoutImprovement", value);
      break;
    case "stop.targetMetric.value": {
      const metric = stop.targetMetric?.metric;
      if (metric === undefined) return { config };
      stop.targetMetric = { metric, value: value as number };
      break;
    }
    case "stop.budget.maxContributions": {
      const budget = { ...(stop.budget ?? {}) } as Mutable<Budget>;
      assign(budget, "maxContributions", value);
      assign(stop, "budget", hasAnyKey(budget) ? budget : undefined);
      break;
    }
    case "stop.budget.maxWallClockSeconds": {
      const budget = { ...(stop.budget ?? {}) } as Mutable<Budget>;
      assign(budget, "maxWallClockSeconds", value);
      assign(stop, "budget", hasAnyKey(budget) ? budget : undefined);
      break;
    }
    case "concurrency.maxActiveClaims":
      assign(conc, "maxActiveClaims", value);
      break;
    case "concurrency.maxClaimsPerAgent":
      assign(conc, "maxClaimsPerAgent", value);
      break;
  }

  const next = { ...config } as Mutable<GroveContract>;
  assign(next, "stopConditions", hasAnyKey(stop) ? stop : undefined);
  assign(next, "concurrency", hasAnyKey(conc) ? conc : undefined);
  return { config: next };
}
