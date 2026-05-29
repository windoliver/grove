import { fuzzyMatch } from "./fuzzy.js";
import type { Action, ActionContext } from "./types.js";
import { GROUP_ORDER } from "./types.js";

/** An available action with label-match metadata for highlighting. */
export interface VisibleAction {
  readonly action: Action;
  readonly matchedIndices: readonly number[];
}

function isAvailable(action: Action, ctx: ActionContext): boolean {
  return action.available?.(ctx) ?? true;
}

/**
 * Produce the ordered, flat list of actions the palette displays.
 *
 * - No query: available actions sorted by GROUP_ORDER (stable within a group).
 * - Query: available actions whose label OR any keyword fuzzy-matches, ranked
 *   by best score (desc). `matchedIndices` reflects the label match only
 *   (empty when only a keyword matched).
 *
 * This single list is the source of truth for BOTH grouped rendering and the
 * keyboard selection index — keeping them in sync.
 */
export function computeVisibleActions(
  actions: readonly Action[],
  ctx: ActionContext,
  query: string,
): readonly VisibleAction[] {
  const available = actions.filter((a) => isAvailable(a, ctx));
  const q = query.trim();

  if (!q) {
    const rank = (a: Action) => (a.suggested ? 0 : 1);
    const ordered = [...available].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      return GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    });
    return ordered.map((action) => ({ action, matchedIndices: [] }));
  }

  const ranked: Array<VisibleAction & { score: number }> = [];
  for (const action of available) {
    const labelResult = fuzzyMatch(q, action.label);
    let best = labelResult.match ? labelResult.score : -1;
    let matchedIndices: readonly number[] = labelResult.match ? labelResult.matchedIndices : [];
    for (const kw of action.keywords ?? []) {
      const r = fuzzyMatch(q, kw);
      if (r.match && r.score > best) {
        best = r.score;
        // Keep label highlight only; a keyword-only match yields no label indices.
        if (!labelResult.match) matchedIndices = [];
      }
    }
    if (action.slash) {
      const r = fuzzyMatch(q, action.slash);
      if (r.match && r.score > best) best = r.score;
    }
    if (best >= 0) ranked.push({ action, matchedIndices, score: best });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.map(({ action, matchedIndices }) => ({ action, matchedIndices }));
}
