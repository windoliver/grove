/**
 * Screen 2: Agent detection + role prompt editing.
 *
 * Shows detected CLIs, role-to-CLI mapping, and editable prompts
 * for each role from the GROVE.md topology. Users can review and
 * customize what each agent will do before spawning.
 *
 * j/k: navigate roles, Enter on a role: edit its prompt
 * Enter (when not editing): continue to goal screen
 * Esc: back or cancel edit
 */

import { useKeyboard } from "@opentui/react";
import React, { useCallback, useEffect, useState } from "react";
import type { AgentTopology } from "../../core/topology.js";
import { PLATFORM_COLORS, theme } from "../theme.js";

/** Known CLI tools and their platform identifiers. */
const AGENT_CLIS: readonly { cli: string; platform: string; label: string }[] = [
  { cli: "claude", platform: "claude-code", label: "Claude Code" },
  { cli: "codex", platform: "codex", label: "Codex CLI" },
  { cli: "gemini", platform: "gemini", label: "Gemini CLI" },
];

/** Props for the AgentDetect screen. */
export interface AgentDetectProps {
  readonly topology?: AgentTopology | undefined;
  readonly onContinue: (
    detected: Map<string, boolean>,
    roleMapping: Map<string, string>,
    rolePrompts: Map<string, string>,
  ) => void;
  readonly onBack: () => void;
}

/** Check if a CLI tool is installed via `which`. */
async function detectCli(name: string): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");
    execSync(`which ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Screen 2: agent detection + role prompt configuration. */
export const AgentDetect: React.NamedExoticComponent<AgentDetectProps> = React.memo(
  function AgentDetect({ topology, onContinue, onBack }: AgentDetectProps): React.ReactNode {
    const [detected, setDetected] = useState<Map<string, boolean>>(new Map());
    const [scanning, setScanning] = useState(true);
    const [cursor, setCursor] = useState(0);
    const [editing, setEditing] = useState(false);
    const [editBuffer, setEditBuffer] = useState("");

    // Role prompts — initialized from topology, editable by user
    const [rolePrompts, setRolePrompts] = useState<Map<string, string>>(() => {
      const map = new Map<string, string>();
      if (topology) {
        for (const role of topology.roles) {
          map.set(role.name, role.prompt ?? role.description ?? "");
        }
      }
      return map;
    });

    const roles = topology?.roles ?? [];

    // Auto-detect CLIs on mount
    useEffect(() => {
      void (async () => {
        const results = new Map<string, boolean>();
        for (const agent of AGENT_CLIS) {
          results.set(agent.cli, await detectCli(agent.cli));
        }
        setDetected(results);
        setScanning(false);
      })();
    }, []);

    // Build role-to-CLI mapping
    const roleMapping = new Map<string, string>();
    if (topology) {
      for (const role of topology.roles) {
        const platform = role.platform ?? "claude-code";
        const cli = AGENT_CLIS.find((a) => a.platform === platform);
        if (cli) roleMapping.set(role.name, cli.cli);
      }
    }

    useKeyboard(
      useCallback(
        (key) => {
          if (editing) {
            if (key.name === "escape") {
              setEditing(false);
              return;
            }
            if (key.name === "return") {
              // Save edit
              const roleName = roles[cursor]?.name;
              if (roleName) {
                setRolePrompts((prev) => {
                  const next = new Map(prev);
                  next.set(roleName, editBuffer);
                  return next;
                });
              }
              setEditing(false);
              return;
            }
            if (key.name === "backspace") {
              setEditBuffer((b) => b.slice(0, -1));
              return;
            }
            if (key.name && key.name.length === 1 && !key.ctrl) {
              setEditBuffer((b) => b + key.name);
              return;
            }
            return;
          }

          // Normal mode
          if (key.name === "j" || key.name === "down") {
            setCursor((c) => Math.min(c + 1, roles.length - 1));
            return;
          }
          if (key.name === "k" || key.name === "up") {
            setCursor((c) => Math.max(c - 1, 0));
            return;
          }
          if (key.name === "e" || (key.name === "return" && roles.length > 0 && cursor < roles.length)) {
            // Edit the selected role's prompt
            const roleName = roles[cursor]?.name;
            if (roleName) {
              setEditBuffer(rolePrompts.get(roleName) ?? "");
              setEditing(true);
            }
            return;
          }
          if (key.name === "return" && !scanning) {
            onContinue(detected, roleMapping, rolePrompts);
            return;
          }
          if (key.name === "escape") {
            onBack();
            return;
          }
        },
        [scanning, detected, roleMapping, rolePrompts, onContinue, onBack, editing, editBuffer, cursor, roles],
      ),
    );

    return (
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        borderStyle="round"
        borderColor={theme.focus}
      >
        <box flexDirection="column" paddingX={2} paddingTop={1}>
          <text color={theme.focus} bold>
            Agent Setup
          </text>
          <text color={theme.muted}>
            {scanning ? "Scanning for installed agent CLIs..." : "Configure role prompts below"}
          </text>
        </box>

        {/* CLI detection */}
        <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
          <text color={theme.text} bold>
            Installed CLIs
          </text>
          {AGENT_CLIS.map((agent) => {
            const found = detected.get(agent.cli);
            const icon = found ? theme.agentRunning : theme.agentIdle;
            const color = found ? theme.success : theme.dimmed;
            const platformColor = PLATFORM_COLORS[agent.platform] ?? theme.text;
            return (
              <box key={agent.cli} flexDirection="row">
                <text color={color}> {icon} </text>
                <text color={platformColor}>{agent.label.padEnd(16)}</text>
                <text color={theme.muted}>
                  {found ? "found" : scanning ? "..." : "not found"}
                </text>
              </box>
            );
          })}
        </box>

        {/* Role prompts — editable */}
        {roles.length > 0 ? (
          <box
            flexDirection="column"
            marginX={2}
            marginTop={1}
            borderStyle="single"
            borderColor={theme.border}
            paddingX={1}
          >
            <text color={theme.text} bold>
              Role Prompts (e:edit, j/k:navigate)
            </text>
            {roles.map((role, i) => {
              const selected = i === cursor;
              const cli = roleMapping.get(role.name) ?? "?";
              const cliFound = detected.get(cli) ?? false;
              const icon = cliFound ? theme.agentRunning : theme.agentIdle;
              const prompt = rolePrompts.get(role.name) ?? "";
              const isEditing = editing && selected;

              return (
                <box
                  key={role.name}
                  flexDirection="column"
                  backgroundColor={selected ? theme.selectedBg : undefined}
                  paddingX={1}
                >
                  <box flexDirection="row">
                    <text color={selected ? theme.focus : theme.text}>
                      {selected ? "> " : "  "}
                    </text>
                    <text color={cliFound ? theme.success : theme.dimmed}>{icon} </text>
                    <text color={theme.text} bold>
                      {role.name}
                    </text>
                    <text color={theme.muted}> ({cli})</text>
                  </box>
                  {isEditing ? (
                    <box flexDirection="row" marginLeft={4}>
                      <text color={theme.focus}>prompt: </text>
                      <text color={theme.text}>
                        {editBuffer}
                        <text color={theme.focus}>_</text>
                      </text>
                    </box>
                  ) : (
                    <box marginLeft={4}>
                      <text color={theme.dimmed}>
                        {prompt ? prompt.slice(0, 80) + (prompt.length > 80 ? "..." : "") : "(no prompt)"}
                      </text>
                    </box>
                  )}
                </box>
              );
            })}
          </box>
        ) : null}

        {/* Hints */}
        <box paddingX={2} marginTop={1}>
          <text color={theme.dimmed}>
            {editing
              ? "Type prompt, Enter:save, Esc:cancel"
              : scanning
                ? "Scanning..."
                : "e:edit prompt  j/k:navigate  Enter:continue  Esc:back"}
          </text>
        </box>
      </box>
    );
  },
);
