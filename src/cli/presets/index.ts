/**
 * Preset registry — named configurations for common Grove setups.
 *
 * Each preset defines topology, metrics, modes, seed data, and service
 * configuration. Used by `grove init --preset <name>`.
 */

import type { AgentTopology } from "../../core/topology.js";
import type {
  ConcurrencyConfig,
  ExecutionConfig,
  GateEntry,
  MetricEntry,
  StopConditionsConfig,
} from "../grove-md-builder.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Seed contribution for demo data. */
export interface SeedContribution {
  readonly kind: "work" | "review" | "discussion";
  readonly mode: "evaluation" | "exploration";
  readonly summary: string;
  readonly tags?: readonly string[] | undefined;
  readonly agentId?: string | undefined;
  readonly role?: string | undefined;
}

/** A complete preset configuration. */
export interface PresetConfig {
  readonly name: string;
  readonly description: string;
  readonly mode: "evaluation" | "exploration";
  readonly metrics?: readonly MetricEntry[] | undefined;
  readonly topology?: AgentTopology | undefined;
  readonly gates?: readonly GateEntry[] | undefined;
  readonly stopConditions?: StopConditionsConfig | undefined;
  readonly concurrency?: ConcurrencyConfig | undefined;
  readonly execution?: ExecutionConfig | undefined;
  readonly seedContributions?: readonly SeedContribution[] | undefined;
  readonly services: { readonly server: boolean; readonly mcp: boolean };
  /**
   * Preferred backend for this preset.
   * - "local": always uses local SQLite (zero-dependency fallback).
   * - "nexus": prefers Nexus as the shared backend; falls back to local
   *   if no nexusUrl is provided at init time.
   */
  readonly backend: "local" | "nexus";
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export { explorationPreset } from "./exploration.js";
export { researchLoopPreset } from "./research-loop.js";
export { reviewLoopPreset } from "./review-loop.js";
export { swarmOpsPreset } from "./swarm-ops.js";

/** All available presets indexed by name. */
export function getPresetRegistry(): Readonly<Record<string, PresetConfig>> {
  // Lazy import to avoid circular deps and keep startup fast
  const { reviewLoopPreset } = require("./review-loop.js") as typeof import("./review-loop.js");
  const { explorationPreset } = require("./exploration.js") as typeof import("./exploration.js");
  const { swarmOpsPreset } = require("./swarm-ops.js") as typeof import("./swarm-ops.js");
  const { researchLoopPreset } =
    require("./research-loop.js") as typeof import("./research-loop.js");

  return {
    "review-loop": reviewLoopPreset,
    exploration: explorationPreset,
    "swarm-ops": swarmOpsPreset,
    "research-loop": researchLoopPreset,
  };
}

/** Get a preset by name, or undefined if not found. */
export function getPreset(name: string): PresetConfig | undefined {
  return getPresetRegistry()[name];
}

/** List all available preset names. */
export function listPresetNames(): readonly string[] {
  return Object.keys(getPresetRegistry());
}
