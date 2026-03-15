/**
 * Command palette overlay for the TUI.
 *
 * Activated via Ctrl+P, displays an interactive selectable list of
 * spawn (role) and kill (session) actions. The parent drives navigation
 * via the `selectedIndex` prop; Enter confirms the selected action.
 */

import React, { useMemo } from "react";
import type { Claim } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import { checkSpawn } from "../agents/spawn-validator.js";
import type { TmuxManager } from "../agents/tmux-manager.js";

/** A single actionable entry in the palette. */
export interface PaletteItem {
  readonly kind: "spawn" | "kill" | "register" | "delegate";
  /** For spawn: role name. For kill: session name. For delegate: peerId. */
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
  hasTmux: boolean,
  hasSpawn: boolean,
  hasKill: boolean,
  parentAgentId?: string | undefined,
  gossipPeers?: readonly { peerId: string; address: string; freeSlots: number }[] | undefined,
  agentProfiles?: readonly LoadedProfile[] | undefined,
): readonly PaletteItem[] {
  const items: PaletteItem[] = [];

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
  if (agentProfiles && agentProfiles.length > 0 && hasTmux && hasSpawn) {
    for (const profile of agentProfiles) {
      profileRoles.add(profile.role);
      const check = topology
        ? checkSpawn(topology, profile.role, activeClaims, parentAgentId)
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
  if (topology && hasTmux && hasSpawn) {
    for (const role of topology.roles) {
      if (profileRoles.has(role.name)) continue;
      const check = checkSpawn(topology, role.name, activeClaims, parentAgentId);
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
  if (hasTmux && hasKill && sessions.length > 0) {
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

/** Ctrl+P command palette overlay with interactive selection. */
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
    items: externalItems,
  }: CommandPaletteProps): React.ReactNode {
    const hasTmux = tmux !== undefined;

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
          hasTmux,
          onSpawn !== undefined,
          onKill !== undefined,
          parentAgentId,
          gossipPeers,
        ),
      [topology, activeClaims, sessions, hasTmux, onSpawn, onKill, parentAgentId, gossipPeers],
    );
    const items = externalItems ?? internalItems;

    if (!visible) {
      return null;
    }

    const idx = selectedIndex ?? 0;

    return (
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <box>
          <text color="#00cccc">Command Palette (Esc to close)</text>
        </box>

        {items.length === 0 && (
          <box paddingLeft={1}>
            <text color="#888888">
              No actions available{!hasTmux ? " (tmux not detected)" : ""}
            </text>
          </box>
        )}

        <box flexDirection="column" paddingLeft={1}>
          {items.map((item, i) => {
            const isSelected = i === idx;
            const dimmed = !item.enabled;
            const labelColor = isSelected ? "#00cccc" : dimmed ? "#555555" : "#ffffff";
            const detailColor = isSelected ? "#00cccc" : dimmed ? "#444444" : "#888888";
            const cursor = isSelected ? "> " : "  ";
            return (
              <box key={`${item.kind}-${item.id}`}>
                <text color={labelColor}>
                  {cursor}
                  {item.label}
                </text>
                <text color={detailColor}> [{item.detail}]</text>
              </box>
            );
          })}
        </box>

        <box marginTop={1} paddingLeft={1}>
          <text color="#888888">[j/k] navigate [Enter] execute [Esc] close</text>
        </box>
      </box>
    );
  },
);
