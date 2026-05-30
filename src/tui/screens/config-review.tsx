/**
 * Config Review screen (#201).
 *
 * Sits between preset-select and goal-input. Shows the session config resolved
 * from the chosen preset and lets the operator edit a focused set of
 * scalar/enum fields (mode, stop-condition thresholds, concurrency limits).
 * Topology, metrics, and gates are shown read-only. All editing logic lives in
 * the pure ./config-edit module.
 *
 * Keys: j/k navigate · e edit scalar · space toggle mode · d reset to preset
 * defaults · Enter confirm & continue · Esc back to preset-select.
 */

import { useKeyboard } from "@opentui/react";
import React, { useCallback, useMemo, useState } from "react";
import type { Gate, GroveContract } from "../../core/contract.js";
import type { AgentTopology } from "../../core/topology.js";
import { theme } from "../theme.js";
import { getEditableFields, setNumericField, toggleMode } from "./config-edit.js";
import { matchesKey } from "./key-match.js";

/** Props for the ConfigReview screen. */
export interface ConfigReviewProps {
  readonly config: GroveContract;
  readonly topology?: AgentTopology | undefined;
  readonly onConfirm: (updated: GroveContract) => void;
  readonly onBack: () => void;
}

function countEdges(topology: AgentTopology): number {
  let n = 0;
  for (const role of topology.roles) n += role.edges?.length ?? 0;
  return n;
}

function gateTarget(g: Gate): string {
  return g.metric ?? g.name ?? g.relationType ?? "";
}

/** Screen 1.5: review and edit the resolved session config before goal input. */
export const ConfigReview: React.NamedExoticComponent<ConfigReviewProps> = React.memo(
  function ConfigReview({
    config,
    topology,
    onConfirm,
    onBack,
  }: ConfigReviewProps): React.ReactNode {
    const [draft, setDraft] = useState<GroveContract>(config);
    const [cursor, setCursor] = useState(0);
    const [editing, setEditing] = useState(false);
    const [buffer, setBuffer] = useState("");
    const [error, setError] = useState<string | undefined>(undefined);

    const fields = useMemo(() => getEditableFields(draft), [draft]);
    const current = fields[Math.min(cursor, fields.length - 1)];

    useKeyboard(
      useCallback(
        (key) => {
          if (editing) {
            if (key.name === "return" || key.name === "enter") {
              if (!current) {
                setEditing(false);
                return;
              }
              const result = setNumericField(draft, current.id, buffer);
              if (result.error) {
                setError(result.error);
                return;
              }
              setDraft(result.config);
              setEditing(false);
              setError(undefined);
              return;
            }
            if (key.name === "escape") {
              setEditing(false);
              setError(undefined);
              return;
            }
            if (key.name === "backspace") {
              setBuffer((b) => b.slice(0, -1));
              return;
            }
            const seq = key.sequence ?? "";
            if (/^[0-9.-]$/.test(seq)) setBuffer((b) => b + seq);
            return;
          }

          // Normal mode
          if (matchesKey(key, "j") || key.name === "down") {
            setCursor((c) => Math.min(c + 1, fields.length - 1));
            return;
          }
          if (matchesKey(key, "k") || key.name === "up") {
            setCursor((c) => Math.max(c - 1, 0));
            return;
          }
          if (key.name === "space" && current?.kind === "enum") {
            setDraft((d) => toggleMode(d));
            return;
          }
          if (matchesKey(key, "e") && current?.kind === "number") {
            setBuffer(current.display === "(unset)" ? "" : current.display);
            setError(undefined);
            setEditing(true);
            return;
          }
          if (matchesKey(key, "d")) {
            setDraft(config);
            setError(undefined);
            return;
          }
          if (key.name === "return" || key.name === "enter") {
            onConfirm(draft);
            return;
          }
          if (key.name === "escape") {
            onBack();
            return;
          }
        },
        [editing, current, draft, buffer, fields.length, config, onConfirm, onBack],
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
            Review session config
          </text>
          <text color={theme.secondary}>{config.name}</text>
        </box>

        {/* Editable settings */}
        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
        >
          <text color={theme.text} bold>
            Settings (e:edit space:toggle mode d:reset)
          </text>
          {fields.map((field, i) => {
            const selected = i === cursor;
            const isEditingThis = editing && selected;
            return (
              <box
                key={field.id}
                flexDirection="row"
                backgroundColor={selected ? theme.selectedBg : undefined}
                paddingX={1}
              >
                <text color={selected ? theme.focus : theme.text}>{selected ? "> " : "  "}</text>
                <text color={theme.text}>{field.label.padEnd(38)}</text>
                <text color={isEditingThis ? theme.focus : theme.secondary}>
                  {isEditingThis ? `${buffer}_` : field.display}
                </text>
              </box>
            );
          })}
          {error ? <text color={theme.error}>{error}</text> : null}
        </box>

        {/* Read-only: topology */}
        {topology && topology.roles.length > 0 ? (
          <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
            <text color={theme.text} bold>
              Topology (read-only)
            </text>
            <text color={theme.secondary}>
              {topology.roles.map((r) => r.name).join(", ")} {"·"} {countEdges(topology)} edges
            </text>
          </box>
        ) : null}

        {/* Read-only: metrics */}
        {draft.metrics && Object.keys(draft.metrics).length > 0 ? (
          <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
            <text color={theme.text} bold>
              Metrics (read-only)
            </text>
            {Object.entries(draft.metrics).map(([name, def]) => (
              <text key={name} color={theme.secondary}>
                {name} ({def.direction}
                {def.gate !== undefined ? `, gate ${def.gate}` : ""})
              </text>
            ))}
          </box>
        ) : null}

        {/* Read-only: gates */}
        {draft.gates && draft.gates.length > 0 ? (
          <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
            <text color={theme.text} bold>
              Gates (read-only)
            </text>
            {draft.gates.map((g, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: gates have no stable identity
              <text key={`${g.type}-${i}`} color={theme.secondary}>
                {g.type}
                {gateTarget(g) ? ` ${"→"} ${gateTarget(g)}` : ""}
              </text>
            ))}
          </box>
        ) : null}

        {/* Hints */}
        <box paddingX={2} marginTop={1}>
          <text color={theme.secondary}>
            {editing
              ? "Type a number  Enter:save  Esc:cancel  (empty clears optional fields)"
              : "j/k:navigate  e:edit  space:toggle mode  d:reset  Enter:continue  Esc:back"}
          </text>
        </box>
      </box>
    );
  },
);
