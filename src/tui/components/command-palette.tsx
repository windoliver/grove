/**
 * Command palette overlay for the TUI.
 *
 * Activated via Ctrl+P, displays an interactive selectable list of
 * spawn (role) and kill (session) actions. The parent drives navigation
 * via the `selectedIndex` prop; Enter confirms the selected action.
 *
 * Supports fuzzy filtering: items matching the query are ranked by score
 * and matched characters are highlighted in bold.
 */

import React, { useMemo } from "react";
import type { Claim } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import { checkSpawn } from "../agents/spawn-validator.js";
import type { TmuxManager } from "../agents/tmux-manager.js";
import { theme } from "../theme.js";

// ---------------------------------------------------------------------------
// Fuzzy match
// ---------------------------------------------------------------------------

/** Result of a fuzzy match attempt. */
interface FuzzyResult {
  readonly match: boolean;
  readonly score: number;
  /** Indices in `text` that matched pattern characters. */
  readonly matchedIndices: readonly number[];
}

/**
 * Fuzzy-match `pattern` against `text`.
 *
 * Scoring:
 *   +2 for a match at position 0, or after a space / '/'
 *   +1 for any other matching character
 */
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

/**
 * Render a label string with matched character indices bolded.
 * Returns an array of React text nodes.
 */
function renderHighlighted(
  label: string,
  matchedIndices: readonly number[],
  baseColor: string,
): React.ReactNode {
  if (matchedIndices.length === 0) {
    return <text color={baseColor}>{label}</text>;
  }
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

/** A single actionable entry in the palette. */
export interface PaletteItem {
  readonly kind: "spawn" | "kill" | "register" | "delegate" | "goal";
  /** For spawn: role name. For kill: session name. For delegate: peerId. Optional for goal. */
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly detail: string;
}

/** Props for the CommandPalette component. */
export interface CommandPaletteProps {
  readonly visible: boolean;
  readonly tmux?: TmuxManager | undefined;
  readonly onClose: () => void;
  readonly onSpawn?: ((agentId: string, command: string, target: string) => void) | undefined;
  readonly onKill?: ((sessionName: string) => void) | undefined;
  readonly topology?: AgentTopology | undefined;
  readonly activeClaims?: readonly Claim[] | undefined;
  /** Active spawn counts per role — for capacity checks without auto-claims. */
  readonly activeSpawnCounts?: ReadonlyMap<string, number> | undefined;
  /** Index of the currently selected palette item (driven by parent). */
  readonly selectedIndex?: number | undefined;
  /** Live tmux sessions for kill actions. */
  readonly sessions?: readonly string[] | undefined;
  /** Parent agent ID for lineage-aware capacity display. */
  readonly parentAgentId?: string | undefined;
  /** Gossip peers with free agent capacity for delegation. */
  readonly gossipPeers?:
    | readonly { peerId: string; address: string; freeSlots: number }[]
    | undefined;
  /** Pre-built palette items from parent (single source of truth). */
  readonly items?: readonly PaletteItem[] | undefined;
  /** Current fuzzy filter query (controlled by parent). */
  readonly query?: string | undefined;
}

/** An agent profile loaded from .grove/agents.json. */
export interface LoadedProfile {
  readonly name: string;
  readonly role: string;
  readonly platform: string;
  readonly command?: string | undefined;
}

/** Build the unified list of palette items from topology roles and tmux sessions. */
export function buildPaletteItems(
  topology: AgentTopology | undefined,
  activeClaims: readonly Claim[],
  sessions: readonly string[],
  hasSpawnRuntime: boolean,
  hasSpawn: boolean,
  hasKill: boolean,
  parentAgentId?: string | undefined,
  gossipPeers?: readonly { peerId: string; address: string; freeSlots: number }[] | undefined,
  agentProfiles?: readonly LoadedProfile[] | undefined,
  hasGoals?: boolean | undefined,
  activeSpawnCounts?: ReadonlyMap<string, number> | undefined,
): readonly PaletteItem[] {
  const items: PaletteItem[] = [];

  // Goal management — only when provider supports goals
  if (hasGoals) {
    items.push({
      label: "Set goal",
      detail: "Set or update the session goal for all agents",
      kind: "goal",
      id: "set-goal",
      enabled: true,
    });
  }

  // Register item — always available at the top
  items.push({
    kind: "register" as const,
    id: "register-agent",
    label: "[r] Register new agent profile",
    enabled: true,
    detail: "agents.json",
  });

  // Spawn items from registered profiles (take precedence over raw topology roles)
  const profileRoles = new Set<string>();
  if (agentProfiles && agentProfiles.length > 0 && hasSpawnRuntime && hasSpawn) {
    for (const profile of agentProfiles) {
      profileRoles.add(profile.role);
      const check = topology
        ? checkSpawn(topology, profile.role, activeClaims, parentAgentId, activeSpawnCounts)
        : { allowed: true, currentInstances: 0 };
      const max =
        "maxInstances" in check && check.maxInstances !== undefined
          ? String(check.maxInstances)
          : "\u221E";
      const suffix = !check.allowed ? " (at capacity)" : "";
      items.push({
        kind: "spawn",
        id: profile.role,
        label: `spawn: ${profile.name} [${profile.platform}]`,
        enabled: check.allowed,
        detail: `${check.currentInstances}/${max}${suffix}`,
      });
    }
  }

  // Spawn items from topology roles (only those not already covered by profiles)
  if (topology && hasSpawnRuntime && hasSpawn) {
    for (const role of topology.roles) {
      if (profileRoles.has(role.name)) continue;
      const check = checkSpawn(topology, role.name, activeClaims, parentAgentId, activeSpawnCounts);
      const max = check.maxInstances !== undefined ? String(check.maxInstances) : "\u221E";
      const suffix = !check.allowed ? " (at capacity)" : "";
      items.push({
        kind: "spawn",
        id: role.name,
        label: `spawn: ${role.name}`,
        enabled: check.allowed,
        detail: `${check.currentInstances}/${max}${suffix}`,
      });
    }
  }

  // Kill items from live tmux sessions
  if (hasSpawnRuntime && hasKill && sessions.length > 0) {
    for (const session of sessions) {
      items.push({
        kind: "kill",
        id: session,
        label: `kill: ${session}`,
        enabled: true,
        detail: "running",
      });
    }
  }

  // Delegate items from gossip peers with free capacity
  if (gossipPeers) {
    for (const peer of gossipPeers) {
      if (peer.freeSlots > 0) {
        items.push({
          kind: "delegate" as const,
          id: peer.address,
          label: `[d] Delegate to ${peer.peerId} (${peer.freeSlots} free)`,
          enabled: true,
          detail: `${peer.freeSlots} slots`,
        });
      }
    }
  }

  return items;
}

/** A palette item augmented with fuzzy match metadata for rendering. */
interface RankedItem {
  readonly item: PaletteItem;
  readonly matchedIndices: readonly number[];
  /** Original index in the unfiltered list (stable key). */
  readonly originalIndex: number;
}

/** Ctrl+P command palette overlay with interactive selection and fuzzy search. */
export const CommandPalette: React.NamedExoticComponent<CommandPaletteProps> = React.memo(
  function CommandPalette({
    visible,
    tmux,
    onClose,
    onSpawn,
    onKill,
    topology,
    activeClaims,
    selectedIndex,
    sessions,
    parentAgentId,
    gossipPeers,
    activeSpawnCounts: _activeSpawnCounts,
    items: externalItems,
    query,
  }: CommandPaletteProps): React.ReactNode {
    const hasSpawnRuntime = tmux !== undefined || onSpawn !== undefined;

    // Suppress unused-variable lint — onClose/onSpawn/onKill are invoked by
    // the parent keyboard handler, not directly by this presentational component.
    void onClose;
    void onSpawn;
    void onKill;

    // Use parent-provided items (single source of truth) or build internally as fallback
    const internalItems = useMemo(
      () =>
        buildPaletteItems(
          topology,
          activeClaims ?? [],
          sessions ?? [],
          hasSpawnRuntime,
          onSpawn !== undefined,
          onKill !== undefined,
          parentAgentId,
          gossipPeers,
        ),
      [
        topology,
        activeClaims,
        sessions,
        hasSpawnRuntime,
        onSpawn,
        onKill,
        parentAgentId,
        gossipPeers,
      ],
    );
    const allItems = externalItems ?? internalItems;

    // Apply fuzzy filtering and sort by score (highest first) when query is set
    const rankedItems = useMemo((): readonly RankedItem[] => {
      const q = query?.trim() ?? "";
      if (!q) {
        return allItems.map((item, i) => ({ item, matchedIndices: [], originalIndex: i }));
      }
      const ranked: Array<RankedItem & { score: number }> = [];
      for (let i = 0; i < allItems.length; i++) {
        const item = allItems[i];
        if (!item) continue;
        const result = fuzzyMatch(q, item.label);
        if (result.match) {
          ranked.push({
            item,
            matchedIndices: result.matchedIndices,
            originalIndex: i,
            score: result.score,
          });
        }
      }
      ranked.sort((a, b) => b.score - a.score);
      return ranked;
    }, [allItems, query]);

    if (!visible) {
      return null;
    }

    const idx = selectedIndex ?? 0;
    const q = query?.trim() ?? "";

    return (
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <box flexDirection="row">
          <text color={theme.focus}>Command Palette</text>
          {q ? (
            <text color={theme.secondary}> — filter: </text>
          ) : (
            <text color={theme.secondary}> (Esc to close)</text>
          )}
          {q ? <text color={theme.text}>{q}</text> : null}
        </box>

        {rankedItems.length === 0 && (
          <box paddingLeft={1}>
            <text color={theme.muted}>
              {q
                ? `No matches for "${q}"`
                : `No actions available${!hasSpawnRuntime ? " (no agent runtime detected)" : ""}`}
            </text>
          </box>
        )}

        <box flexDirection="column" paddingLeft={1}>
          {rankedItems.map(({ item, matchedIndices, originalIndex }, i) => {
            const isSelected = i === idx;
            const dimmed = !item.enabled;
            const labelColor = isSelected ? theme.focus : dimmed ? theme.disabled : theme.text;
            const detailColor = isSelected ? theme.focus : dimmed ? theme.inactive : theme.muted;
            const cursor = isSelected ? "> " : "  ";
            return (
              <box key={`${item.kind}-${item.id}-${originalIndex}`} flexDirection="row">
                <text color={labelColor}>{cursor}</text>
                {q && matchedIndices.length > 0 ? (
                  renderHighlighted(item.label, matchedIndices, labelColor)
                ) : (
                  <text color={labelColor}>{item.label}</text>
                )}
                <text color={detailColor}> [{item.detail}]</text>
              </box>
            );
          })}
        </box>

        <box marginTop={1} paddingLeft={1}>
          <text color={theme.muted}>[j/k] navigate [Enter] execute [Esc] close</text>
        </box>
      </box>
    );
  },
);
