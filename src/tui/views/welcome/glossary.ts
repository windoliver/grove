/**
 * Concept glossary shown via `?` overlay on first-run.
 *
 * Moved out of the old `views/welcome.tsx` so the overlay can be summoned
 * from any first-run sub-view without duplicating copy.
 */

export interface GlossaryEntry {
  readonly term: string;
  readonly definition: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  { term: "Contribution", definition: "Immutable snapshot of work (code, review, discussion)" },
  { term: "DAG", definition: "Dependency graph of all contributions" },
  { term: "Frontier", definition: "Ranked leaderboard of best contributions per metric" },
  { term: "Claim", definition: "Lease-based lock preventing duplicate agent work" },
  { term: "Topology", definition: "Who talks to whom (coder\u2192reviewer, explorer\u2192critic)" },
  { term: "Nexus", definition: "Shared backend for multi-agent coordination" },
];
