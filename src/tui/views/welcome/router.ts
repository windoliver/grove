/**
 * Pure routing decisions for the welcome flow.
 *
 * Decides which top-level branch (fast-path, first-run, connect, new-session)
 * the welcome UI should render based on grove existence and session inventory.
 * Also resolves the default preset for each first-run mode.
 *
 * Kept free of React and I/O so it can be unit-tested in isolation.
 */

import type { SessionRecord } from "../../provider.js";

/** First-run mode axis: backend selection. */
export type WelcomeMode = "local" | "connected";

/** Route the welcome UI should render. */
export type WelcomeRoute =
  | { readonly kind: "fast-path" }
  | { readonly kind: "first-run"; readonly step: "mode" | "customize" }
  | { readonly kind: "new-session" }
  | { readonly kind: "connect"; readonly returnTo: "fast-path" | "first-run" };

/** Input for initial route resolution. */
export interface RouterInput {
  readonly groveExists: boolean;
  readonly sessions: readonly SessionRecord[];
}

/** Preset shape consumed by default-preset resolution. */
export interface PresetLite {
  readonly name: string;
  readonly description: string;
}

/**
 * Pick the starting welcome route.
 *
 *  - No grove → first-run wizard (mode picker).
 *  - Grove exists (any session count) → fast-path. Empty list rendered inside.
 *
 * `autoConnectNexus` is handled upstream in `TuiApp` and does not reach here.
 */
export function resolveInitialRoute(input: RouterInput): WelcomeRoute {
  if (!input.groveExists) {
    return { kind: "first-run", step: "mode" };
  }
  return { kind: "fast-path" };
}

/**
 * Resolve the default preset name for a first-run mode.
 *
 *  - Local: first preset in list (smallest / most generic).
 *  - Connected: first preset whose name starts with `team-`; falls back to
 *    first preset overall if none match.
 */
export function resolveDefaultPreset(
  mode: WelcomeMode,
  presets: readonly PresetLite[],
): string | undefined {
  if (presets.length === 0) return undefined;
  if (mode === "local") return presets[0]?.name;
  const team = presets.find((p) => p.name.startsWith("team-"));
  return team?.name ?? presets[0]?.name;
}
