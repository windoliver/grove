/**
 * Fast-path welcome screen — returning operator experience.
 *
 * Shows a session list with rich top-row rendering, filter, archive toggle,
 * and footer action hints. Enter resumes the focused session.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

    // Pending* refs are the synchronously-updated source of truth the
    // keyboard handler reads from. React state mirrors them so the UI still
    // re-renders, but a burst like `/`+`j` or `a`+`j` queued before render
    // must see the post-action value — so wrappers update the ref
    // immediately, before scheduling setState.
    const pendingFilterModeRef = useRef(filterMode);
    const pendingArchiveVisibleRef = useRef(archiveVisible);
    const pendingCursorRef = useRef(cursor);
    const visibleIdsRef = useRef(visibleIds);
    visibleIdsRef.current = visibleIds;

    // Reclamp cursor when the visible list shrinks (archive toggle or filter
    // narrow). Without this the cursor can point past the end of the list
    // until the user hits k to scroll back.
    useEffect(() => {
      const max = Math.max(0, visibleIds.length - 1);
      if (pendingCursorRef.current > max) {
        pendingCursorRef.current = max;
        setCursor(max);
      }
    }, [visibleIds.length]);

    useKeyboard(
      useCallback(
        (key) => {
          const ids = visibleIdsRef.current;
          routeFastPathKey(
            key,
            {
              cursor: pendingCursorRef.current,
              visibleSessionIds: ids,
              filterMode: pendingFilterModeRef.current,
              archiveVisible: pendingArchiveVisibleRef.current,
            },
            {
              moveCursor: (delta) => {
                const max = Math.max(0, visibleIdsRef.current.length - 1);
                const next = Math.max(0, Math.min(pendingCursorRef.current + delta, max));
                pendingCursorRef.current = next;
                setCursor(next);
              },
              enterFilter: () => {
                pendingFilterModeRef.current = true;
                setFilterMode(true);
                setFilterText("");
              },
              exitFilter: () => {
                pendingFilterModeRef.current = false;
                pendingCursorRef.current = 0;
                setFilterMode(false);
                setFilterText("");
                setCursor(0);
              },
              commitFilter: () => {
                pendingFilterModeRef.current = false;
                pendingCursorRef.current = 0;
                setFilterMode(false);
                setCursor(0);
              },
              appendFilterChar: (c) => setFilterText((prev) => prev + c),
              deleteFilterChar: () => setFilterText((prev) => prev.slice(0, -1)),
              toggleArchive: () => {
                const next = !pendingArchiveVisibleRef.current;
                pendingArchiveVisibleRef.current = next;
                setArchiveVisible(next);
              },
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
