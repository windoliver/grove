/**
 * Screen 1: Preset selection — choose a preset or recent session.
 *
 * Shows available presets and recent sessions. j/k navigate, Enter selects,
 * c creates custom, q quits, ? shows details.
 */

import { useKeyboard } from "@opentui/react";
import React, { useCallback, useState } from "react";
import { EmptyState } from "../components/empty-state.js";
import type { SessionRecord } from "../provider.js";
import { theme } from "../theme.js";
import type { TuiPresetEntry } from "../tui-app.js";

/** Props for the PresetSelect screen. */
export interface PresetSelectProps {
  readonly presets: readonly TuiPresetEntry[];
  readonly sessions?: readonly SessionRecord[] | undefined;
  /** Whether presets are still loading. */
  readonly loading?: boolean | undefined;
  /** Parse or load error message. */
  readonly error?: string | undefined;
  readonly onSelect: (presetName: string) => void;
  readonly onQuit: () => void;
}

/** Screen 1: preset selection with j/k navigation. */
export const PresetSelect: React.NamedExoticComponent<PresetSelectProps> = React.memo(
  function PresetSelect({
    presets,
    sessions,
    loading,
    error,
    onSelect,
    onQuit,
  }: PresetSelectProps): React.ReactNode {
    const [cursor, setCursor] = useState(0);
    const [showDetail, setShowDetail] = useState(false);

    useKeyboard(
      useCallback(
        (key) => {
          const input = key.name;
          if (input === "q" && !showDetail) {
            onQuit();
            return;
          }
          if (input === "j" || input === "down") {
            setCursor((c) => Math.min(c + 1, presets.length - 1));
            return;
          }
          if (input === "k" || input === "up") {
            setCursor((c) => Math.max(c - 1, 0));
            return;
          }
          if (input === "return") {
            const selected = presets[cursor];
            if (selected) onSelect(selected.name);
            return;
          }
          if (input === "?" || (key.shift && input === "/")) {
            setShowDetail((v) => !v);
            return;
          }
          if (input === "escape" && showDetail) {
            setShowDetail(false);
            return;
          }
        },
        [presets, cursor, onSelect, onQuit, showDetail],
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
            Grove
          </text>
        </box>

        {/* Active session resume */}
        {sessions?.some((s) => s.status === "active") ? (
          <box flexDirection="column" marginX={2} paddingX={1}>
            {sessions
              .filter((s) => s.status === "active")
              .slice(0, 1)
              .map((s) => (
                <text key={s.sessionId} color={theme.warning}>
                  {"\u26a0"} Active session found: Resume {s.sessionId.slice(0, 8)}{" "}
                  {s.contributionCount}c
                </text>
              ))}
          </box>
        ) : null}

        {/* Loading state */}
        {loading ? (
          <box marginX={2} marginTop={1} paddingX={1}>
            <EmptyState title="Scanning..." />
          </box>
        ) : null}

        {/* Error state */}
        {error ? (
          <box marginX={2} marginTop={1} paddingX={1}>
            <text color={theme.error}>{error}</text>
          </box>
        ) : null}

        {/* Empty state */}
        {!loading && !error && presets.length === 0 ? (
          <box marginX={2} marginTop={1} paddingX={1}>
            <EmptyState title="No presets found." hint="Run `grove init` to create one." />
          </box>
        ) : null}

        {/* Preset list */}
        {presets.length > 0 ? (
          <box
            flexDirection="column"
            marginX={2}
            marginTop={1}
            borderStyle="single"
            borderColor={theme.border}
            paddingX={1}
          >
            {presets.map((preset, i) => {
              const selected = i === cursor;
              const prefix = selected ? "> " : "  ";
              return (
                <box
                  key={preset.name}
                  flexDirection="row"
                  backgroundColor={selected ? theme.selectedBg : undefined}
                >
                  <text color={selected ? theme.focus : theme.text} bold={selected}>
                    {`${prefix}${preset.name.padEnd(20)}`}
                  </text>
                  <text color={theme.muted}>{preset.description}</text>
                </box>
              );
            })}
          </box>
        ) : null}

        {/* Detail overlay */}
        {showDetail && presets[cursor] ? (
          <box
            flexDirection="column"
            marginX={2}
            marginTop={1}
            borderStyle="single"
            borderColor={theme.info}
            paddingX={1}
          >
            <text color={theme.info} bold>
              Preset: {presets[cursor]?.name ?? ""}
            </text>
            <text color={theme.text}>{presets[cursor]?.description ?? ""}</text>
            {presets[cursor]?.details ? (
              <box flexDirection="column" marginTop={1}>
                {presets[cursor]?.details?.split("\n").map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: detail lines have no stable identity
                  <text key={i} color={theme.muted}>
                    {line}
                  </text>
                ))}
              </box>
            ) : null}
            <text color={theme.dimmed}>Press ? to close details</text>
          </box>
        ) : null}

        {/* Recent sessions */}
        {sessions && sessions.length > 0 ? (
          <box
            flexDirection="column"
            marginX={2}
            marginTop={1}
            borderStyle="single"
            borderColor={theme.border}
            paddingX={1}
          >
            <text color={theme.focus} bold>
              Recent sessions
            </text>
            {sessions.slice(0, 5).map((s) => (
              <text key={s.sessionId} color={theme.muted}>
                {"  "}
                {`"${s.goal ?? "untitled"}"`} ({s.contributionCount} contributions, {s.status})
              </text>
            ))}
          </box>
        ) : null}

        {/* Keyboard hints */}
        <box paddingX={2} marginTop={1}>
          <text color={theme.dimmed}>j/k:navigate Enter:select ?:details q:quit</text>
        </box>
      </box>
    );
  },
);
