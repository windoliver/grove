/**
 * Command palette overlay for the TUI.
 *
 * Activated via Ctrl+P, displays available commands.
 * Displays available commands with role status information.
 */

import React, { useMemo } from "react";
import type { Claim } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import { checkSpawn } from "../agents/spawn-validator.js";
import type { TmuxManager } from "../agents/tmux-manager.js";

/** Props for the CommandPalette component. */
export interface CommandPaletteProps {
  readonly visible: boolean;
  readonly tmux?: TmuxManager | undefined;
  readonly onClose: () => void;
  readonly onSpawn?: ((agentId: string, command: string, target: string) => void) | undefined;
  readonly onKill?: ((sessionName: string) => void) | undefined;
  readonly topology?: AgentTopology | undefined;
  readonly activeClaims?: readonly Claim[] | undefined;
}

/** Available command descriptors. */
interface CommandEntry {
  readonly label: string;
  readonly description: string;
  readonly requiresTmux: boolean;
}

/** Static list of available commands. */
const COMMANDS: readonly CommandEntry[] = [
  {
    label: "/spawn <command> --target <ref>",
    description: "Spawn agent (local only, requires tmux)",
    requiresTmux: true,
  },
  {
    label: "/kill <session>",
    description: "Kill agent session",
    requiresTmux: true,
  },
  {
    label: "/refresh",
    description: "Force refresh all panels",
    requiresTmux: false,
  },
  {
    label: "/quit",
    description: "Quit TUI",
    requiresTmux: false,
  },
];

/** Build a display line for a role's instance count. */
function formatRoleStatus(
  roleName: string,
  currentInstances: number,
  maxInstances: number | undefined,
  atCapacity: boolean,
): string {
  const max = maxInstances !== undefined ? String(maxInstances) : "\u221E";
  const suffix = atCapacity ? " (at capacity)" : "";
  return `  ${roleName.padEnd(14)} ${currentInstances}/${max}${suffix}`;
}

/** Ctrl+P command palette overlay showing available commands. */
export const CommandPalette: React.NamedExoticComponent<CommandPaletteProps> = React.memo(
  function CommandPalette({
    visible,
    tmux,
    onClose,
    onSpawn,
    onKill,
    topology,
    activeClaims,
  }: CommandPaletteProps): React.ReactNode {
    const hasTmux = tmux !== undefined;

    // onClose is provided for future interactive use; parent handles Esc via keyboard
    void onClose;

    const roleLines = useMemo(() => {
      if (topology === undefined) return [];
      const claims = activeClaims ?? [];
      return topology.roles.map((role) => {
        const check = checkSpawn(topology, role.name, claims);
        return formatRoleStatus(
          role.name,
          check.currentInstances,
          check.maxInstances,
          !check.allowed,
        );
      });
    }, [topology, activeClaims]);

    if (!visible) {
      return null;
    }

    const canSpawn = hasTmux && onSpawn !== undefined;
    const canKill = hasTmux && onKill !== undefined;

    return (
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <box>
          <text color="#00cccc">Command Palette (Esc to close)</text>
        </box>
        <box flexDirection="column" paddingLeft={1}>
          {COMMANDS.map((cmd) => {
            const dimmed = cmd.requiresTmux && !hasTmux;
            return (
              <box key={cmd.label}>
                <text color={dimmed ? "#555555" : "#ffffff"}>{cmd.label}</text>
                <text color={dimmed ? "#444444" : "#888888"}> — {cmd.description}</text>
                {dimmed && <text color="#555555"> (unavailable)</text>}
              </box>
            );
          })}
        </box>
        <box marginTop={1} paddingLeft={1}>
          <text color="#888888">
            {canSpawn ? "[s]pawn " : ""}
            {canKill ? "[k]ill " : ""}
            [Esc] close
          </text>
        </box>
        {roleLines.length > 0 && (
          <box flexDirection="column" paddingLeft={1} marginTop={1}>
            <box>
              <text color="#00cccc">Available roles:</text>
            </box>
            {roleLines.map((line) => (
              <box key={line}>
                <text color={line.includes("(at capacity)") ? "#ff6600" : "#888888"}>{line}</text>
              </box>
            ))}
          </box>
        )}
      </box>
    );
  },
);
