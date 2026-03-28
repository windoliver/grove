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
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentTopology } from "../../core/topology.js";
import { BreadcrumbBar } from "../components/breadcrumb-bar.js";
import { EmptyState } from "../components/empty-state.js";
import { renderGraph } from "../layout/edge-render.js";
import { layoutGraph } from "../layout/graph-layout.js";
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

/** Check if a CLI tool is installed. */
function detectCli(name: string): boolean {
  return Bun.which(name) !== null;
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
      const results = new Map<string, boolean>();
      for (const agent of AGENT_CLIS) {
        results.set(agent.cli, detectCli(agent.cli));
      }
      setDetected(results);
      setScanning(false);
    }, []);

    // Editable role-to-CLI mapping — initialized from topology platform, user can cycle
    const [roleMapping, setRoleMapping] = useState<Map<string, string>>(() => {
      const map = new Map<string, string>();
      if (topology) {
        for (const role of topology.roles) {
          const platform = role.platform ?? "claude-code";
          const cli = AGENT_CLIS.find((a) => a.platform === platform);
          if (cli) map.set(role.name, cli.cli);
        }
      }
      return map;
    });

    // Available CLIs (detected and installed)
    const availableClis = AGENT_CLIS.filter((a) => detected.get(a.cli) === true).map((a) => a.cli);

    // Compute topology DAG visualization
    const dagLines = useMemo(() => {
      if (!topology || topology.roles.length < 2) return [];
      const hasEdges = topology.roles.some((r) => r.edges && r.edges.length > 0);
      if (!hasEdges) return [];
      const layout = layoutGraph(topology.roles, topology.structure ?? "graph");
      const buffer = renderGraph(layout);
      return buffer.lines;
    }, [topology]);

    // Count mapped roles (only count roles whose selected CLI is actually installed)
    const mappedCount = roles.filter((r) => {
      const cli = roleMapping.get(r.name);
      return cli && detected.get(cli);
    }).length;
    const totalCount = roles.length;

    // Auto-default all roles to first available CLI if their current CLI isn't installed
    useEffect(() => {
      if (scanning || availableClis.length === 0) return;
      setRoleMapping((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const role of roles) {
          const current = next.get(role.name);
          if (!current || !detected.get(current)) {
            const fallback = availableClis[0];
            if (fallback) {
              next.set(role.name, fallback);
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });
    }, [scanning, availableClis, roles, detected]);

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
            if (key.name === "space") {
              setEditBuffer((b) => `${b} `);
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
          // c: cycle CLI for the selected role
          if (key.name === "c" && availableClis.length > 0) {
            const roleName = roles[cursor]?.name;
            if (roleName) {
              const currentCli = roleMapping.get(roleName) ?? availableClis[0] ?? "claude";
              const currentIdx = availableClis.indexOf(currentCli);
              const nextIdx = (currentIdx + 1) % availableClis.length;
              const nextCli = availableClis[nextIdx];
              if (nextCli) {
                setRoleMapping((prev) => {
                  const next = new Map(prev);
                  next.set(roleName, nextCli);
                  return next;
                });
              }
            }
            return;
          }
          // e: edit the selected role's prompt
          if (key.name === "e") {
            const roleName = roles[cursor]?.name;
            if (roleName) {
              setEditBuffer(rolePrompts.get(roleName) ?? "");
              setEditing(true);
            }
            return;
          }
          // Any of these keys: continue to goal input
          if (
            key.name === "return" ||
            key.name === "tab" ||
            key.name === "right" ||
            key.name === "enter" ||
            key.name === "space"
          ) {
            if (!scanning) {
              onContinue(detected, roleMapping, rolePrompts);
            }
            return;
          }
          if (key.name === "escape") {
            onBack();
            return;
          }
        },
        [
          scanning,
          detected,
          roleMapping,
          rolePrompts,
          onContinue,
          onBack,
          editing,
          editBuffer,
          cursor,
          roles,
          availableClis,
        ],
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
        <BreadcrumbBar screen="agent-detect" width={100} />

        <box flexDirection="column" paddingX={2} paddingTop={1}>
          <text color={theme.focus} bold>
            {scanning ? "Scanning..." : "Detection complete"}
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
                <text color={theme.muted}>{found ? "found" : scanning ? "..." : "not found"}</text>
              </box>
            );
          })}
          {!scanning && ![...detected.values()].some(Boolean) ? (
            <EmptyState
              title="No agent CLIs found."
              hint="Install claude, codex, or gemini CLI to continue."
            />
          ) : null}
        </box>

        {/* Topology DAG */}
        {dagLines.length > 0 ? (
          <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
            <text color={theme.text} bold>
              Topology
            </text>
            {dagLines.map((line) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: dag lines have no stable identity
              <text key={line} color={theme.muted}>
                {line}
              </text>
            ))}
          </box>
        ) : null}

        {/* Role Mapping summary */}
        {roles.length > 0 ? (
          <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
            <text color={theme.text} bold>
              Role Mapping
            </text>
            {roles.map((role) => {
              const cli = roleMapping.get(role.name) ?? "?";
              const cliFound = detected.get(cli) ?? false;
              const icon = cliFound ? theme.agentRunning : theme.agentIdle;
              const color = cliFound ? theme.success : theme.dimmed;
              return (
                <box key={role.name} flexDirection="row">
                  <text color={color}> {icon} </text>
                  <text color={theme.text}>{role.name.padEnd(12)}</text>
                  <text color={theme.dimmed}>{"\u2192"} </text>
                  <text color={PLATFORM_COLORS[role.platform ?? "claude-code"] ?? theme.text}>
                    {cli}
                  </text>
                  <text color={color}> {icon}</text>
                </box>
              );
            })}
            {mappedCount < totalCount ? (
              <text color={theme.warning}>
                {"\u26a0"} {mappedCount}/{totalCount} roles mapped
              </text>
            ) : null}
          </box>
        ) : null}

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
                    <box marginLeft={4} flexDirection="column">
                      <text color={selected ? theme.muted : theme.dimmed} wrap="wrap">
                        {prompt
                          ? selected
                            ? prompt
                            : prompt.slice(0, 70) + (prompt.length > 70 ? "..." : "")
                          : "(no prompt — press e to add one)"}
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
                : "c:change CLI  e:edit prompt  j/k:navigate  Enter/Tab:continue  Esc:back"}
          </text>
        </box>
      </box>
    );
  },
);
