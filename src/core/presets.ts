/**
 * Core preset topology registry.
 *
 * Extracts ONLY the topology-bearing fields from the CLI presets so that
 * the API / server layer can resolve preset topologies without pulling in
 * CLI-specific dependencies (services, backend, seedContributions, etc.).
 */

import type { AgentTopology } from "./topology.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Topology-only subset of a preset configuration. */
export interface CorePresetConfig {
  readonly name: string;
  readonly description: string;
  readonly topology?: AgentTopology | undefined;
}

// ---------------------------------------------------------------------------
// Memoized registry
// ---------------------------------------------------------------------------

let _registry: Readonly<Record<string, CorePresetConfig>> | undefined;

/** Return the full registry of preset topologies, memoized after first call. */
export function getPresetTopologyRegistry(): Readonly<Record<string, CorePresetConfig>> {
  if (_registry) return _registry;

  _registry = {
    "review-loop": {
      name: "review-loop",
      description: "Code review loop with coder and reviewer roles",
      topology: {
        structure: "graph",
        roles: [
          {
            name: "coder",
            description: "Writes and iterates on code",
            maxInstances: 1,
            edges: [{ target: "reviewer", edgeType: "delegates" }],
            platform: "claude-code",
            prompt:
              "You are a software engineer. Your workflow:\n" +
              "1. Read the codebase and understand the goal\n" +
              "2. Edit files to implement the solution\n" +
              "3. Call grove_submit_work to submit your work:\n" +
              '   grove_submit_work({ summary: "Implemented landing page", artifacts: {"index.html": "blake3:..."}, agent: { role: "coder" } })\n' +
              "4. Reviewer feedback arrives automatically — when it does, iterate and grove_submit_work again\n" +
              "5. NEVER call grove_done yourself. Only the reviewer ends the session.\n" +
              "You MUST call grove_submit_work after editing files — without it, nobody sees your work.",
          },
          {
            name: "reviewer",
            description: "Reviews code and provides feedback",
            maxInstances: 1,
            edges: [{ target: "coder", edgeType: "feedback" }],
            platform: "claude-code",
            prompt:
              "You are a code reviewer. Your workflow:\n" +
              "1. Coder contributions arrive automatically — wait for the first one\n" +
              "2. Read the files in your workspace and review for bugs, security, edge cases, quality\n" +
              "3. Submit your review via grove_submit_review:\n" +
              '   grove_submit_review({ targetCid: "blake3:...", summary: "LGTM — clean implementation", scores: {"correctness": {"value": 0.9, "direction": "maximize"}}, agent: { role: "reviewer" } })\n' +
              "4. If changes needed, your review is sent to the coder automatically\n" +
              '5. When code meets standards, call grove_done({ summary: "Approved — code meets standards", agent: { role: "reviewer" } })\n' +
              "You MUST call grove_submit_review for every review — without it, the coder gets no feedback.",
          },
        ],
        spawning: { dynamic: true, maxDepth: 2 },
      },
    },

    exploration: {
      name: "exploration",
      description: "Open-ended exploration with explorer, critic, and synthesizer",
      topology: {
        structure: "graph",
        roles: [
          {
            name: "explorer",
            description: "Proposes new ideas and approaches",
            maxInstances: 3,
            edges: [
              { target: "critic", edgeType: "delegates" },
              { target: "synthesizer", edgeType: "feeds" },
            ],
            command: "claude --role explorer",
          },
          {
            name: "critic",
            description: "Evaluates and challenges proposals",
            maxInstances: 2,
            edges: [
              { target: "explorer", edgeType: "feedback" },
              { target: "synthesizer", edgeType: "feeds" },
            ],
            command: "claude --role critic",
          },
          {
            name: "synthesizer",
            description: "Combines insights into coherent results",
            maxInstances: 1,
            edges: [{ target: "explorer", edgeType: "requests" }],
            command: "claude --role synthesizer",
          },
        ],
        spawning: { dynamic: true, maxDepth: 3 },
      },
    },

    "swarm-ops": {
      name: "swarm-ops",
      description: "Multi-agent swarm with coordinator, workers, and QA",
      topology: {
        structure: "tree",
        roles: [
          {
            name: "coordinator",
            description: "Assigns work and monitors progress",
            maxInstances: 1,
            edges: [
              { target: "worker", edgeType: "delegates" },
              { target: "qa", edgeType: "delegates" },
            ],
            command: "claude --role coordinator",
            prompt:
              "Loop: grove_frontier (survey state) → grove_list_claims → grove_read_inbox → " +
              "grove_create_plan/grove_update_plan → grove_send_message to delegate → " +
              "grove_check_stop → repeat.",
          },
          {
            name: "worker",
            description: "Executes assigned tasks",
            maxInstances: 5,
            command: "claude --role worker",
            prompt:
              "Loop: grove_frontier → grove_claim → grove_checkout → code → " +
              "grove_submit_work (with artifacts) → grove_read_inbox for feedback → repeat.",
          },
          {
            name: "qa",
            description: "Reviews and validates completed work",
            maxInstances: 2,
            command: "claude --role qa",
            prompt:
              "Loop: grove_frontier (find unreviewed work) → grove_claim → grove_checkout → " +
              "review → grove_submit_review (with quality scores) → grove_send_message if action " +
              "needed → repeat.",
          },
        ],
        spawning: { dynamic: true, maxDepth: 2, maxChildrenPerAgent: 5 },
      },
    },

    "research-loop": {
      name: "research-loop",
      description: "Benchmark-driven research loop with val_bpb:minimize",
      topology: {
        structure: "graph",
        roles: [
          {
            name: "researcher",
            description: "Proposes and implements improvements",
            maxInstances: 3,
            edges: [{ target: "evaluator", edgeType: "delegates" }],
            command: "claude --role researcher",
          },
          {
            name: "evaluator",
            description: "Runs benchmarks and reports results",
            maxInstances: 2,
            edges: [{ target: "researcher", edgeType: "feedback" }],
            command: "claude --role evaluator",
          },
        ],
        spawning: { dynamic: true, maxDepth: 2 },
      },
    },

    "pr-review": {
      name: "pr-review",
      description: "GitHub PR review with multi-agent code analysis",
      topology: {
        structure: "graph",
        roles: [
          {
            name: "reviewer",
            description: "Reviews PR code changes and provides feedback",
            maxInstances: 3,
            edges: [{ target: "analyst", edgeType: "delegates" }],
            command: "claude --role reviewer",
            platform: "claude-code",
          },
          {
            name: "analyst",
            description: "Deep-dives into specific files or patterns",
            maxInstances: 2,
            edges: [{ target: "reviewer", edgeType: "reports" }],
            command: "claude --role analyst",
            platform: "claude-code",
          },
        ],
        spawning: { dynamic: true, maxDepth: 2 },
      },
    },

    "federated-swarm": {
      name: "federated-swarm",
      description: "Federated multi-node agent swarm with gossip coordination",
      topology: {
        structure: "flat",
        roles: [
          {
            name: "worker",
            description: "General-purpose task worker",
            maxInstances: 8,
            command: "claude --role worker",
            platform: "claude-code",
          },
        ],
        spawning: { dynamic: true, maxDepth: 1, maxChildrenPerAgent: 4 },
      },
    },
  };

  return _registry;
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Look up a preset's topology by name. Returns undefined if the preset is unknown or has no topology. */
export function lookupPresetTopology(name: string): AgentTopology | undefined {
  return getPresetTopologyRegistry()[name]?.topology;
}

/** List all available preset names. */
export function listPresetNames(): readonly string[] {
  return Object.keys(getPresetTopologyRegistry());
}
