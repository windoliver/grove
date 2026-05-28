/**
 * Command palette overlay for the TUI.
 *
 * Renders the unified Action model. With no query, actions are shown grouped by
 * section (Navigation, Agents, Workflow, Contributions, Plugins). With a query,
 * group headers are hidden and a single fuzzy-ranked list is shown. The parent
 * drives selection via `selectedIndex` over the flat `computeVisibleActions`
 * list; Enter executes the selected action.
 */

import React, { useMemo } from "react";
import type { Action, ActionContext, ActionGroup } from "../actions/types.js";
import { computeVisibleActions } from "../actions/visibility.js";
import { theme } from "../theme.js";

interface FuzzyResult {
  readonly match: boolean;
  readonly score: number;
  readonly matchedIndices: readonly number[];
}

/** Fuzzy-match `pattern` against `text`. (+2 at word boundary, +1 otherwise.) */
export function fuzzyMatch(pattern: string, text: string): FuzzyResult {
  if (!pattern) return { match: true, score: 0, matchedIndices: [] };
  const lower = text.toLowerCase();
  const pat = pattern.toLowerCase();
  let pi = 0;
  let score = 0;
  const matchedIndices: number[] = [];
  for (let i = 0; i < lower.length && pi < pat.length; i++) {
    if (lower[i] === pat[pi]) {
      const bonus = i === 0 || lower[i - 1] === " " || lower[i - 1] === "/" ? 2 : 1;
      score += bonus;
      matchedIndices.push(i);
      pi++;
    }
  }
  return { match: pi === pat.length, score, matchedIndices };
}

function renderHighlighted(
  label: string,
  matchedIndices: readonly number[],
  baseColor: string,
): React.ReactNode {
  if (matchedIndices.length === 0) return <text color={baseColor}>{label}</text>;
  const indexSet = new Set(matchedIndices);
  const segments: React.ReactNode[] = [];
  let run = "";
  let runHighlighted = false;
  const flush = (highlighted: boolean, key: string) => {
    if (!run) return;
    segments.push(
      highlighted ? (
        <text key={key} color={theme.focus} bold>
          {run}
        </text>
      ) : (
        <text key={key} color={baseColor}>
          {run}
        </text>
      ),
    );
    run = "";
  };
  for (let i = 0; i < label.length; i++) {
    const h = indexSet.has(i);
    if (h !== runHighlighted) {
      flush(runHighlighted, `s${i}`);
      runHighlighted = h;
    }
    run += label[i];
  }
  flush(runHighlighted, "end");
  return <box flexDirection="row">{segments}</box>;
}

export interface CommandPaletteProps {
  readonly visible: boolean;
  readonly actions: readonly Action[];
  readonly ctx: ActionContext;
  readonly query?: string | undefined;
  readonly selectedIndex?: number | undefined;
  readonly adoptContext?: { readonly targetCid: string; readonly summary: string } | undefined;
}

export const CommandPalette: React.NamedExoticComponent<CommandPaletteProps> = React.memo(
  function CommandPalette({
    visible,
    actions,
    ctx,
    query,
    selectedIndex,
    adoptContext,
  }: CommandPaletteProps): React.ReactNode {
    const q = (query ?? "").trim();
    const visibleActions = useMemo(() => computeVisibleActions(actions, ctx, q), [actions, ctx, q]);

    if (!visible) return null;
    const idx = selectedIndex ?? 0;

    // When no query, compute the group header to print before each item.
    const headerBefore: (ActionGroup | undefined)[] = [];
    if (!q) {
      let lastGroup: ActionGroup | undefined;
      for (const { action } of visibleActions) {
        headerBefore.push(action.group !== lastGroup ? action.group : undefined);
        lastGroup = action.group;
      }
    }

    return (
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <box flexDirection="row">
          <text color={theme.focus}>Command Palette</text>
          {adoptContext ? (
            <text color={theme.compare}>{` Adopt: ${adoptContext.targetCid.slice(0, 12)}…`}</text>
          ) : null}
          {q ? (
            <text color={theme.secondary}> — filter: </text>
          ) : (
            <text color={theme.secondary}> (Esc to close)</text>
          )}
          {q ? <text color={theme.text}>{q}</text> : null}
        </box>

        {visibleActions.length === 0 && (
          <box paddingLeft={1}>
            <text color={theme.secondary}>
              {q ? `No matches for "${q}"` : "No actions available"}
            </text>
          </box>
        )}

        <box flexDirection="column" paddingLeft={1}>
          {visibleActions.map(({ action, matchedIndices }, i) => {
            const isSelected = i === idx;
            const dimmed = !(action.enabled?.(ctx) ?? true);
            const labelColor = isSelected ? theme.focus : dimmed ? theme.disabled : theme.text;
            const detailColor = isSelected
              ? theme.focus
              : dimmed
                ? theme.inactive
                : theme.secondary;
            const cursor = isSelected ? "> " : "  ";
            const group = !q ? headerBefore[i] : undefined;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: index disambiguates the stable action.id
              <box key={`${action.id}-${i}`} flexDirection="column">
                {group ? (
                  <text color={theme.secondary} bold>
                    {group}
                  </text>
                ) : null}
                <box flexDirection="row">
                  <text color={labelColor}>{cursor}</text>
                  {q && matchedIndices.length > 0 ? (
                    renderHighlighted(action.label, matchedIndices, labelColor)
                  ) : (
                    <text color={labelColor}>{action.label}</text>
                  )}
                  {action.detail ? <text color={detailColor}> [{action.detail}]</text> : null}
                </box>
              </box>
            );
          })}
        </box>

        <box marginTop={1} paddingLeft={1}>
          <text color={theme.secondary}>[j/k] navigate [Enter] execute [Esc] close</text>
        </box>
      </box>
    );
  },
);
