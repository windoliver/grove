/**
 * Fast-path welcome screen — returning operator experience.
 *
 * Shows a session list with rich top-row rendering, filter, archive toggle,
 * and footer action hints. Enter resumes the focused session.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useMemo, useRef, useState } from "react";
import type { SessionRecord } from "../../provider.js";
import { theme } from "../../theme.js";
import { routeFastPathKey } from "./fast-path-keyboard.js";
import { SessionRow } from "./session-row.js";

export interface FastPathProps {
  readonly groveName: string;
  readonly sessions: readonly SessionRecord[];
  readonly onResume: (sessionId: string) => void;
  readonly onNewSession: () => void;
  readonly onConnect: () => void;
  readonly onQuit: () => void;
}

const VISIBLE_WINDOW = 20;

export const FastPath: React.NamedExoticComponent<FastPathProps> = React.memo(
  function FastPath({
    groveName,
    sessions,
    onResume,
    onNewSession,
    onConnect,
    onQuit,
  }: FastPathProps): React.ReactNode {
    const [cursor, setCursor] = useState(0);
    const [filterMode, setFilterMode] = useState(false);
    const [filterText, setFilterText] = useState("");
    const [archiveVisible, setArchiveVisible] = useState(false);
    void useRenderer();

    // Apply archive toggle and filter — in that order.
    const visibleSessions = useMemo(() => {
      const base = archiveVisible ? sessions : sessions.filter((s) => s.status !== "archived");
      if (!filterText) return base;
      const needle = filterText.toLowerCase();
      return base.filter((s) => (s.goal ?? "").toLowerCase().includes(needle));
    }, [sessions, filterText, archiveVisible]);

    const { activeCount, archivedCount } = useMemo(() => {
      let active = 0;
      let archived = 0;
      for (const s of sessions) {
        if (s.status === "active") active++;
        else if (s.status === "archived") archived++;
      }
      return { activeCount: active, archivedCount: archived };
    }, [sessions]);

    const visibleIds = useMemo(
      () => visibleSessions.map((s) => s.id),
      [visibleSessions],
    );

    // Refs mirror current cursor/filterMode/archiveVisible so the handler
    // reads values that are still consistent with rendered state even if the
    // handler was registered on an earlier render. For `filterText`, rapid
    // typing can queue several key events before React re-renders, so we
    // rely on functional setState inside the actions instead of a ref read.
    const cursorRef = useRef(cursor);
    const filterModeRef = useRef(filterMode);
    const archiveVisibleRef = useRef(archiveVisible);
    const visibleIdsRef = useRef(visibleIds);
    cursorRef.current = cursor;
    filterModeRef.current = filterMode;
    archiveVisibleRef.current = archiveVisible;
    visibleIdsRef.current = visibleIds;

    useKeyboard(
      useCallback(
        (key) => {
          const ids = visibleIdsRef.current;
          routeFastPathKey(
            key,
            {
              cursor: cursorRef.current,
              visibleSessionIds: ids,
              filterMode: filterModeRef.current,
              archiveVisible: archiveVisibleRef.current,
            },
            {
              setCursor: (n) => setCursor(Math.min(n, Math.max(0, ids.length - 1))),
              enterFilter: () => {
                setFilterMode(true);
                setFilterText("");
              },
              exitFilter: () => {
                setFilterMode(false);
                setFilterText("");
                setCursor(0);
              },
              appendFilterChar: (c) => setFilterText((prev) => prev + c),
              deleteFilterChar: () => setFilterText((prev) => prev.slice(0, -1)),
              toggleArchive: () => setArchiveVisible((v) => !v),
              onResume,
              onNewSession,
              onConnect,
              onQuit,
            },
          );
        },
        [onResume, onNewSession, onConnect, onQuit],
      ),
    );

    // Windowing for long lists
    const windowStart = Math.max(0, cursor - Math.floor(VISIBLE_WINDOW / 2));
    const windowEnd = Math.min(visibleSessions.length, windowStart + VISIBLE_WINDOW);
    const windowed = visibleSessions.slice(windowStart, windowEnd);

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
            {`Grove · ${groveName}`}
          </text>
          <text color={theme.secondary}>{""}</text>
          <text color={theme.text}>
            {`Continue session  (${activeCount} active${archivedCount > 0 ? `, ${archivedCount} archived` : ""})`}
          </text>
          {filterMode ? (
            <box flexDirection="row">
              <text color={theme.focus}>{"/ "}</text>
              <text>{filterText}</text>
              <text color={theme.focus}>▌</text>
            </box>
          ) : null}
        </box>

        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
        >
          {visibleSessions.length === 0 ? (
            sessions.length === 0 ? (
              <box flexDirection="column">
                <text color={theme.text}>{`Grove "${groveName}" ready.`}</text>
                <text color={theme.secondary}>No sessions yet. Press [n] to start one.</text>
              </box>
            ) : (
              <text color={theme.secondary}>
                {filterText ? "No sessions match filter" : "No visible sessions"}
              </text>
            )
          ) : null}
          {windowed.map((s, i) => {
            const globalIdx = windowStart + i;
            return (
              <SessionRow
                key={s.id}
                session={s}
                focused={globalIdx === cursor}
              />
            );
          })}
        </box>

        <box paddingX={2} marginTop={1}>
          <text color={theme.secondary}>
            [Enter] resume  [n] new  [c] connect  [a] archive  [/] filter  [q] quit
          </text>
        </box>
      </box>
    );
  },
);
