import { formatKeySequence, type KeyBinding, type KeySequence } from "./keymap.js";

export interface ChordCandidate {
  readonly key: string;
  readonly label: string;
}

/** Next-key options for bindings whose sequence extends `prefix` by ≥1 token. */
export function candidateContinuations(
  bindings: readonly KeyBinding[],
  prefix: KeySequence,
): readonly ChordCandidate[] {
  const out: ChordCandidate[] = [];
  const seen = new Set<string>();
  for (const b of bindings) {
    if (b.sequence.length <= prefix.length) continue;
    if (!prefix.every((t, i) => b.sequence[i] === t)) continue;
    const nextToken = b.sequence[prefix.length];
    if (nextToken === undefined || seen.has(nextToken)) continue;
    seen.add(nextToken);
    out.push({ key: formatKeySequence([nextToken]), label: b.label });
  }
  return out;
}

/** Window after the leader key during which the chord stays armed. */
export const LEADER_CHORD_TIMEOUT_MS = 2000;
