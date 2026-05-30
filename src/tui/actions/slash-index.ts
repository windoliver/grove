import type { Action } from "./types.js";

export function buildSlashIndex(actions: readonly Action[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const a of actions) {
    if (a.slash && !map.has(a.slash)) map.set(a.slash, a.id);
  }
  return map;
}

export interface SlashResolution {
  readonly id: string;
  readonly args: readonly string[];
}

export function resolveSlash(
  index: ReadonlyMap<string, string>,
  input: string,
): SlashResolution | undefined {
  const tokens = input
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const cmd = tokens[0];
  if (cmd === undefined) return undefined;
  const id = index.get(cmd);
  if (id === undefined) return undefined;
  return { id, args: tokens.slice(1) };
}
