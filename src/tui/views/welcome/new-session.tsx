/**
 * New-session preset picker — invoked via `n` from the fast-path. Grove
 * backend is already resolved; we only ask for the preset. The goal prompt
 * is handled by the subsequent ScreenManager goal-input screen.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { theme } from "../../theme.js";
import type { TuiPresetEntry } from "../../tui-app.js";
import { routeNewSessionKey } from "./new-session-keyboard.js";

export interface NewSessionProps {
  readonly groveName: string;
  readonly presets: readonly TuiPresetEntry[];
  readonly onPick: (presetName: string) => void;
  readonly onBack: () => void;
  readonly onQuit: () => void;
}

export const NewSession: React.NamedExoticComponent<NewSessionProps> = React.memo(
  function NewSession({
    groveName,
    presets,
    onPick,
    onBack,
    onQuit,
  }: NewSessionProps): React.ReactNode {
    const [cursor, setCursor] = useState(0);
    const [detailOpen, setDetailOpen] = useState(false);
    void useRenderer();

    // Pending* refs are synchronously updated by their wrappers so rapid
    // j+j+Enter lands on the post-nav row and `?`+j is swallowed while the
    // detail overlay is open — not the stale render-commit value.
    const pendingCursorRef = useRef(cursor);
    const pendingDetailOpenRef = useRef(detailOpen);

    useEffect(() => {
      const max = Math.max(0, presets.length - 1);
      if (pendingCursorRef.current > max) {
        pendingCursorRef.current = max;
        setCursor(max);
      }
    }, [presets.length]);

    useKeyboard(
      useCallback(
        (key) => {
          routeNewSessionKey(
            key,
            {
              cursor: pendingCursorRef.current,
              presetCount: presets.length,
              detailOpen: pendingDetailOpenRef.current,
            },
            {
              moveCursor: (delta) => {
                const max = Math.max(0, presets.length - 1);
                const next = Math.max(0, Math.min(pendingCursorRef.current + delta, max));
                pendingCursorRef.current = next;
                setCursor(next);
              },
              toggleDetail: () => {
                const next = !pendingDetailOpenRef.current;
                pendingDetailOpenRef.current = next;
                setDetailOpen(next);
              },
              onPick: (i) => {
                const name = presets[i]?.name;
                if (name) onPick(name);
              },
              onBack,
              onQuit,
            },
          );
        },
        [presets, onPick, onBack, onQuit],
      ),
    );

    const focused = presets[cursor];

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
            {`New session in ${groveName}`}
          </text>
          <text color={theme.secondary}>{""}</text>
          <text color={theme.text}>Pick a preset for this session:</text>
        </box>

        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
        >
          {presets.map((p, i) => {
            const selected = i === cursor;
            const prefix = selected ? "> " : "  ";
            return (
              <box
                key={p.name}
                flexDirection="row"
                backgroundColor={selected ? theme.selectedBg : undefined}
              >
                <text color={selected ? theme.focus : theme.text} bold={selected}>
                  {`${prefix}${p.name.padEnd(20)}`}
                </text>
                <text color={theme.secondary}>{p.description}</text>
              </box>
            );
          })}
        </box>

        {detailOpen && focused ? (
          <box
            flexDirection="column"
            marginX={2}
            marginTop={1}
            borderStyle="round"
            borderColor={theme.info}
            paddingX={1}
          >
            <text color={theme.info} bold>
              {focused.name}
            </text>
            <text color={theme.text}>{focused.description}</text>
            {focused.details
              ? focused.details.split("\n").map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: detail lines have no stable identity
                  <text key={i} color={theme.secondary}>
                    {line}
                  </text>
                ))
              : null}
            <text color={theme.secondary}>Press ? or Esc to close</text>
          </box>
        ) : null}

        <box paddingX={2} marginTop={1}>
          <text color={theme.secondary}>[j/k] navigate [Enter] pick [?] details [Esc] back</text>
        </box>
      </box>
    );
  },
);
