/**
 * Topology resolution — determines which AgentTopology a session should use.
 *
 * Precedence (highest to lowest):
 *   1. Explicit inline topology (API body / direct parameter)
 *   2. Named preset (--preset flag / API preset field)
 *   3. GROVE.md default topology (contract.topology)
 *
 * The resolver is a pure function: all inputs are explicit, no side effects.
 */

import type { AgentTopology } from "./topology.js";

/** Input sources for topology resolution. */
export interface TopologyResolutionInput {
  /** Explicit inline topology (highest priority). */
  readonly inlineTopology?: AgentTopology | undefined;
  /** Named preset — resolved to a topology via the preset lookup function. */
  readonly presetName?: string | undefined;
  /** GROVE.md contract default topology (lowest priority). */
  readonly contractDefault?: AgentTopology | undefined;
}

/** Successful resolution result. */
export interface TopologyResolutionSuccess {
  readonly ok: true;
  readonly topology: AgentTopology;
  readonly source: "inline" | "preset" | "contract";
}

/** Failed resolution result. */
export interface TopologyResolutionFailure {
  readonly ok: false;
  readonly error: string;
}

export type TopologyResolutionResult = TopologyResolutionSuccess | TopologyResolutionFailure;

/** Preset lookup function — returns a topology for a named preset, or undefined. */
export type PresetLookup = (name: string) => AgentTopology | undefined;

/**
 * Resolve which topology to use for a session.
 *
 * @param input - The resolution sources (inline, preset, contract default)
 * @param lookupPreset - Function to look up a preset by name. Only called if presetName is provided.
 * @returns Resolution result with the topology and its source, or an error.
 */
export function resolveTopology(
  input: TopologyResolutionInput,
  lookupPreset?: PresetLookup,
): TopologyResolutionResult {
  // 1. Inline topology wins
  if (input.inlineTopology !== undefined) {
    return { ok: true, topology: input.inlineTopology, source: "inline" };
  }

  // 2. Named preset
  if (input.presetName !== undefined) {
    if (!lookupPreset) {
      return {
        ok: false,
        error: `Preset '${input.presetName}' requested but no preset registry available`,
      };
    }
    const topology = lookupPreset(input.presetName);
    if (topology === undefined) {
      return { ok: false, error: `Unknown preset '${input.presetName}'` };
    }
    return { ok: true, topology, source: "preset" };
  }

  // 3. GROVE.md contract default
  if (input.contractDefault !== undefined) {
    return { ok: true, topology: input.contractDefault, source: "contract" };
  }

  return {
    ok: false,
    error: "No topology available: provide --preset, an inline topology, or define one in GROVE.md",
  };
}
