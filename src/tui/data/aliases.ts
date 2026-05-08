/**
 * Pure alias resolver for the C2 command prompt.
 *
 * Resolves k9s-style aliases (e.g. ":a" → agents view) with recursion
 * (max 8 hops), cycle detection, and argv passthrough. No IO, no React.
 */

export interface AliasEntry {
  /** Resolved command. May start with ":" to chain into another alias. */
  readonly value: string;
}

export type AliasMap = ReadonlyMap<string, AliasEntry>;

export const MAX_ALIAS_DEPTH = 8;

export const DEFAULT_ALIASES: AliasMap = new Map<string, AliasEntry>([
  ["a", { value: "agents" }],
  ["s", { value: "sessions" }],
  ["t", { value: "tasks" }],
  ["d", { value: "dag" }],
  ["r", { value: "reviews" }],
  ["q", { value: "quit" }],
]);

export type ResolveResult =
  | { kind: "ok"; command: string; argv: readonly string[]; chain: readonly string[] }
  | { kind: "miss"; key: string }
  | { kind: "cycle"; chain: readonly string[] }
  | { kind: "depth"; chain: readonly string[] };

export function resolveAlias(_map: AliasMap, _input: string): ResolveResult {
  throw new Error("not implemented");
}

export function matchAliases(_map: AliasMap, _prefix: string): readonly string[] {
  throw new Error("not implemented");
}
