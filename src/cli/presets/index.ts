/**
 * Preset registry — named configurations for common Grove setups.
 *
 * Each preset defines topology, metrics, modes, seed data, and service
 * configuration. Used by `grove init --preset <name>`.
 */

import { type GroveContract, parseGroveContract } from "../../core/contract.js";
import type { CorePresetConfig } from "../../core/presets.js";
import type { AgentTopology } from "../../core/topology.js";
import type {
  ConcurrencyConfig,
  ExecutionConfig,
  GateEntry,
  HooksConfig,
  MetricEntry,
  StopConditionsConfig,
} from "../grove-md-builder.js";
import { buildGroveMd, presetToGroveMdConfig } from "../grove-md-builder.js";
import { evalLoopPreset } from "./eval-loop.js";
import { explorationPreset } from "./exploration.js";
import { federatedSwarmPreset } from "./federated-swarm.js";
import { prReviewPreset } from "./pr-review.js";
import { researchLoopPreset } from "./research-loop.js";
import { reviewLoopPreset } from "./review-loop.js";
import { swarmOpsPreset } from "./swarm-ops.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Boardroom feature flags — TUI reads these to auto-enable panels. */
export interface BoardroomFeatures {
  readonly github?: { readonly autoDetectPR: boolean } | undefined;
  readonly askUser?: { readonly strategy: string; readonly perAgent: boolean } | undefined;
  readonly gossip?: { readonly delegateSpawning: boolean } | undefined;
  readonly costTracking?: boolean | undefined;
  readonly messaging?: boolean | undefined;
}

/** Seed contribution for demo data. */
export interface SeedContribution {
  readonly kind: "work" | "review" | "discussion";
  readonly mode: "evaluation" | "exploration";
  readonly summary: string;
  readonly tags?: readonly string[] | undefined;
  readonly agentId?: string | undefined;
  readonly role?: string | undefined;
}

/** A complete preset configuration (extends CorePresetConfig with CLI-specific fields). */
export interface PresetConfig extends CorePresetConfig {
  readonly mode: "evaluation" | "exploration";
  readonly metrics?: readonly MetricEntry[] | undefined;
  readonly topology?: AgentTopology | undefined;
  readonly gates?: readonly GateEntry[] | undefined;
  readonly stopConditions?: StopConditionsConfig | undefined;
  readonly concurrency?: ConcurrencyConfig | undefined;
  readonly execution?: ExecutionConfig | undefined;
  readonly hooks?: HooksConfig | undefined;
  readonly seedContributions?: readonly SeedContribution[] | undefined;
  readonly services: { readonly server: boolean; readonly mcp: boolean };
  /**
   * Preferred backend for this preset.
   * - "local": always uses local SQLite (zero-dependency fallback).
   * - "nexus": prefers Nexus as the shared backend; falls back to local
   *   if no nexusUrl is provided at init time.
   */
  readonly backend: "local" | "nexus";
  /** Boardroom feature flags — TUI reads these to auto-enable panels. */
  readonly features?: BoardroomFeatures | undefined;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export {
  evalLoopPreset,
  explorationPreset,
  federatedSwarmPreset,
  prReviewPreset,
  researchLoopPreset,
  reviewLoopPreset,
  swarmOpsPreset,
};

let _registry: Readonly<Record<string, PresetConfig>> | undefined;

/** All available presets indexed by name (memoized after first call). */
export function getPresetRegistry(): Readonly<Record<string, PresetConfig>> {
  if (_registry) return _registry;

  _registry = {
    "review-loop": reviewLoopPreset,
    exploration: explorationPreset,
    "swarm-ops": swarmOpsPreset,
    "research-loop": researchLoopPreset,
    "pr-review": prReviewPreset,
    "federated-swarm": federatedSwarmPreset,
    "eval-loop": evalLoopPreset,
  };

  return _registry;
}

/** Get a preset by name, or undefined if not found. */
export function getPreset(name: string): PresetConfig | undefined {
  return getPresetRegistry()[name];
}

/** List all available preset names. */
export function listPresetNames(): readonly string[] {
  return Object.keys(getPresetRegistry());
}

// ---------------------------------------------------------------------------
// Preset → GroveContract conversion
// ---------------------------------------------------------------------------

/**
 * Build a `GroveContract` from a preset by round-tripping through
 * `buildGroveMd` + `parseGroveContract`. This is the same pipeline that
 * `grove init --preset <name>` uses on disk — same output, same validation
 * surface. Used by the server when no GROVE.md is loaded and a caller
 * supplies a preset name on `POST /api/sessions`.
 *
 * `name` is the grove-level name (e.g. the goal or a caller-supplied
 * identifier). The preset's own `name` is the preset ID
 * (e.g. "review-loop") and is not used here.
 */
export function presetToSessionConfig(preset: PresetConfig, name: string): GroveContract {
  const mdConfig = presetToGroveMdConfig(
    { ...preset, presetDescription: preset.description },
    { name, description: preset.description },
  );
  const md = buildGroveMd(mdConfig);
  return parseGroveContract(md);
}
