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

export function resolveAlias(map: AliasMap, input: string): ResolveResult {
  return resolveInternal(map, input, 0, new Set<string>(), []);
}

function resolveInternal(
  map: AliasMap,
  input: string,
  depth: number,
  visited: Set<string>,
  chain: readonly string[],
): ResolveResult {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "miss", key: "" };
  const tokens = trimmed.split(/\s+/);
  const key = tokens[0] ?? "";
  const rest = tokens.slice(1);

  if (visited.has(key)) return { kind: "cycle", chain: [...chain, key] };
  if (depth > MAX_ALIAS_DEPTH) return { kind: "depth", chain };

  const entry = map.get(key);
  if (!entry) {
    return depth === 0 ? { kind: "miss", key } : { kind: "ok", command: key, argv: rest, chain };
  }

  // Terminal alias: value does not start with ":"
  if (!entry.value.startsWith(":")) {
    const valueTokens = entry.value.split(/\s+/);
    const cmd = valueTokens[0] ?? "";
    const valueArgs = valueTokens.slice(1);
    return {
      kind: "ok",
      command: cmd,
      argv: [...valueArgs, ...rest],
      chain: [...chain, key],
    };
  }

  // Recursive alias: value starts with ":"
  visited.add(key);
  const next = entry.value.slice(1) + (rest.length ? ` ${rest.join(" ")}` : "");
  return resolveInternal(map, next, depth + 1, visited, [...chain, key]);
}

export function matchAliases(map: AliasMap, prefix: string): readonly string[] {
  const p = prefix.toLowerCase();
  const matches: string[] = [];
  for (const key of map.keys()) {
    if (key.toLowerCase().startsWith(p)) matches.push(key);
  }
  matches.sort();
  return matches;
}
