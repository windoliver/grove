/**
 * Configurable thresholds for SupervisionScreen heuristics.
 *
 * Resolution order (later wins):
 *   1. DEFAULT_THRESHOLDS
 *   2. process.env GROVE_TUI_SUP_*
 *   3. explicit overrides argument to loadThresholds()
 */

export interface SupervisionThresholds {
  readonly silentMs: number;
  readonly stuckMs: number;
  readonly thrashWindowMs: number;
  readonly thrashContribs: number;
  readonly completedRetentionMs: number;
  readonly costSpikeUsdPerMin: number;
  readonly contextPctWarn: number;
  readonly contextPctCritical: number;
}

export const DEFAULT_THRESHOLDS: SupervisionThresholds = Object.freeze({
  silentMs: 120_000,
  stuckMs: 600_000,
  thrashWindowMs: 60_000,
  thrashContribs: 6,
  completedRetentionMs: 60_000,
  costSpikeUsdPerMin: 1.0,
  contextPctWarn: 85,
  contextPctCritical: 95,
});

const ENV_KEYS: Readonly<Record<keyof SupervisionThresholds, string>> = {
  silentMs: "GROVE_TUI_SUP_SILENT_MS",
  stuckMs: "GROVE_TUI_SUP_STUCK_MS",
  thrashWindowMs: "GROVE_TUI_SUP_THRASH_WINDOW_MS",
  thrashContribs: "GROVE_TUI_SUP_THRASH_CONTRIBS",
  completedRetentionMs: "GROVE_TUI_SUP_COMPLETED_RETENTION_MS",
  costSpikeUsdPerMin: "GROVE_TUI_SUP_COST_SPIKE_USD_PER_MIN",
  contextPctWarn: "GROVE_TUI_SUP_CONTEXT_PCT_WARN",
  contextPctCritical: "GROVE_TUI_SUP_CONTEXT_PCT_CRITICAL",
};

function parseEnv(key: string, def: number): number {
  const raw = process.env[key];
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  return n;
}

export function loadThresholds(
  overrides?: Partial<SupervisionThresholds>,
): SupervisionThresholds {
  const fromEnv: SupervisionThresholds = {
    silentMs: parseEnv(ENV_KEYS.silentMs, DEFAULT_THRESHOLDS.silentMs),
    stuckMs: parseEnv(ENV_KEYS.stuckMs, DEFAULT_THRESHOLDS.stuckMs),
    thrashWindowMs: parseEnv(ENV_KEYS.thrashWindowMs, DEFAULT_THRESHOLDS.thrashWindowMs),
    thrashContribs: parseEnv(ENV_KEYS.thrashContribs, DEFAULT_THRESHOLDS.thrashContribs),
    completedRetentionMs: parseEnv(
      ENV_KEYS.completedRetentionMs,
      DEFAULT_THRESHOLDS.completedRetentionMs,
    ),
    costSpikeUsdPerMin: parseEnv(
      ENV_KEYS.costSpikeUsdPerMin,
      DEFAULT_THRESHOLDS.costSpikeUsdPerMin,
    ),
    contextPctWarn: parseEnv(ENV_KEYS.contextPctWarn, DEFAULT_THRESHOLDS.contextPctWarn),
    contextPctCritical: parseEnv(
      ENV_KEYS.contextPctCritical,
      DEFAULT_THRESHOLDS.contextPctCritical,
    ),
  };
  return { ...fromEnv, ...overrides };
}
