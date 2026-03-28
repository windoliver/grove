/**
 * Welcome / setup screen view — always shown when the TUI starts.
 *
 * Three-step flow:
 *  1. Action selection: Resume (if .grove/ exists), New grove, Connect to remote Nexus
 *  2a. If "New grove": Preset selection with j/k navigation, ? for detail overlay
 *  2b. If "Connect": URL input
 *  3. If "New grove": Name input (character-by-character) then Enter to confirm
 *
 * After completion, the appropriate callback is invoked:
 * - onResume() for resuming an existing grove
 * - onSelect(presetName, groveName) for creating a new grove
 * - onConnect(nexusUrl) for connecting to a remote Nexus
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useMemo, useState } from "react";
import { theme } from "../theme.js";

/** A preset entry for the welcome screen. */
export interface PresetEntry {
  readonly name: string;
  readonly description: string;
  /** Extended details for the ? overlay (mode, backend, topology, metrics). */
  readonly details?: string | undefined;
}

/** Props for the WelcomeScreen component. */
export interface WelcomeProps {
  readonly presets: readonly PresetEntry[];
  /** Whether a .grove/ directory exists. */
  readonly groveExists: boolean;
  /** Info about the existing grove (name + preset). */
  readonly groveInfo?: { name: string; preset: string } | undefined;
  /** Past sessions to display for resumption. */
  readonly sessions?: readonly import("../provider.js").SessionRecord[] | undefined;
  /** Called with (presetName, groveName) after user completes the "New grove" flow. */
  readonly onSelect: (presetName: string, groveName: string) => void;
  /** Called when user picks "Resume" to start the existing grove. */
  readonly onResume: () => void;
  /** Called with a Nexus URL when user completes the "Connect" flow. */
  readonly onConnect: (nexusUrl: string) => void;
  readonly onQuit: () => void;
}

/** Concept glossary entries displayed on the welcome screen. */
const GLOSSARY: readonly { term: string; definition: string }[] = [
  { term: "Contribution", definition: "Immutable snapshot of work (code, review, discussion)" },
  { term: "DAG", definition: "Dependency graph of all contributions" },
  { term: "Frontier", definition: "Ranked leaderboard of best contributions per metric" },
  { term: "Claim", definition: "Lease-based lock preventing duplicate agent work" },
  { term: "Topology", definition: "Who talks to whom (coder\u2192reviewer, explorer\u2192critic)" },
  { term: "Nexus", definition: "Shared backend for multi-agent coordination" },
];

/** Action item for the setup menu. */
interface ActionItem {
  readonly id: string;
  readonly label: string;
}

type WelcomeStep = "action" | "sessions" | "preset" | "name" | "connect";

/** Welcome screen shown as the first thing the user sees. */
export const WelcomeScreen: React.NamedExoticComponent<WelcomeProps> = React.memo(
  function WelcomeScreen({
    presets,
    groveExists,
    groveInfo,
    sessions,
    onSelect,
    onResume,
    onConnect,
    onQuit,
  }: WelcomeProps): React.ReactNode {
    const [cursor, setCursor] = useState(0);
    const [showDetail, setShowDetail] = useState(false);
    const [step, setStep] = useState<WelcomeStep>("action");
    const [selectedPreset, setSelectedPreset] = useState("");
    const [nameBuffer, setNameBuffer] = useState("");
    const [urlBuffer, setUrlBuffer] = useState("http://localhost:2026");
    const [sessionCursor, setSessionCursor] = useState(0);
    const [sessionFilter, setSessionFilter] = useState("");
    const [sessionFilterMode, setSessionFilterMode] = useState(false);
    void useRenderer();

    // Session data
    const allSessions = sessions ?? [];
    const activeSessions = allSessions.filter((s) => s.status === "active");
    const archivedCount = allSessions.length - activeSessions.length;
    const filteredSessions = sessionFilter
      ? allSessions.filter((s) =>
          (s.goal ?? "").toLowerCase().includes(sessionFilter.toLowerCase()),
        )
      : allSessions;

    // Build action items
    const actions = useMemo<readonly ActionItem[]>(() => {
      const items: ActionItem[] = [];
      if (allSessions.length > 0) {
        items.push({
          id: "sessions",
          label: `Continue session  ▸  (${activeSessions.length} active${archivedCount > 0 ? `, ${archivedCount} archived` : ""})`,
        });
      } else if (groveExists && groveInfo) {
        items.push({ id: "resume", label: `Resume "${groveInfo.name}" (${groveInfo.preset})` });
      }
      items.push({ id: "new", label: "New session (select preset)" });
      items.push({ id: "connect", label: "Connect to remote Nexus" });
      return items;
    }, [groveExists, groveInfo, allSessions.length, activeSessions.length, archivedCount]);

    useKeyboard(
      useCallback(
        (key) => {
          const input = key.name;
          const isCtrl = key.ctrl;

          if (input === "q" && step === "action" && !showDetail) {
            onQuit();
            return;
          }

          // -- Session browser step --
          if (step === "sessions") {
            if (sessionFilterMode) {
              if (input === "escape") {
                setSessionFilterMode(false);
                setSessionFilter("");
                return;
              }
              if (input === "return") {
                setSessionFilterMode(false);
                setSessionCursor(0);
                return;
              }
              if (input === "backspace") {
                setSessionFilter((f) => f.slice(0, -1));
                return;
              }
              if (input && input.length === 1 && !isCtrl) {
                setSessionFilter((f) => f + input);
                return;
              }
              if (input === "space") {
                setSessionFilter((f) => `${f} `);
                return;
              }
              return;
            }

            if (input === "escape") {
              setStep("action");
              setSessionFilter("");
              setSessionFilterMode(false);
              return;
            }
            if (input === "j" || input === "down") {
              setSessionCursor((c) => Math.min(c + 1, filteredSessions.length - 1));
              return;
            }
            if (input === "k" || input === "up") {
              setSessionCursor((c) => Math.max(c - 1, 0));
              return;
            }
            if (key.sequence === "/") {
              setSessionFilterMode(true);
              setSessionFilter("");
              return;
            }
            if (input === "return") {
              const session = filteredSessions[sessionCursor];
              if (session) {
                onResume();
              }
              return;
            }
            return;
          }

          // -- URL input step (Connect to remote Nexus) --
          if (step === "connect") {
            if (input === "escape") {
              setStep("action");
              setCursor(actions.findIndex((a) => a.id === "connect"));
              return;
            }
            if (input === "return") {
              const url = urlBuffer.trim();
              if (url.length > 0) {
                onConnect(url);
              }
              return;
            }
            if (input === "backspace") {
              setUrlBuffer((b) => b.slice(0, -1));
              return;
            }
            if (input && input.length === 1 && !isCtrl) {
              setUrlBuffer((b) => b + input);
              return;
            }
            return;
          }

          // -- Name input step --
          if (step === "name") {
            if (input === "escape") {
              setStep("preset");
              return;
            }
            if (input === "return") {
              const name = nameBuffer.trim();
              if (name.length > 0) {
                onSelect(selectedPreset, name);
              }
              return;
            }
            if (input === "backspace") {
              setNameBuffer((b) => b.slice(0, -1));
              return;
            }
            if (input && input.length === 1 && !isCtrl) {
              setNameBuffer((b) => b + input);
              return;
            }
            return;
          }

          // -- Preset selection step --
          if (step === "preset") {
            if (input === "escape") {
              setStep("action");
              setCursor(actions.findIndex((a) => a.id === "new"));
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
              if (selected) {
                setSelectedPreset(selected.name);
                const defaultName = process.cwd().split("/").pop() ?? "my-grove";
                setNameBuffer(defaultName);
                setStep("name");
              }
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
            return;
          }

          // -- Action selection step --
          if (step === "action") {
            if (input === "j" || input === "down") {
              setCursor((c) => Math.min(c + 1, actions.length - 1));
              return;
            }
            if (input === "k" || input === "up") {
              setCursor((c) => Math.max(c - 1, 0));
              return;
            }
            if (input === "return") {
              const action = actions[cursor];
              if (!action) return;

              if (action.id === "sessions") {
                setStep("sessions");
                setSessionCursor(0);
                setSessionFilter("");
                return;
              }
              if (action.id === "resume" || action.id.startsWith("continue:")) {
                onResume();
                return;
              }
              if (action.id === "new") {
                setCursor(0);
                setStep("preset");
                return;
              }
              if (action.id === "connect") {
                setUrlBuffer("http://localhost:2026");
                setStep("connect");
                return;
              }
            }
          }
        },
        [
          presets,
          actions,
          cursor,
          onSelect,
          onResume,
          onConnect,
          onQuit,
          step,
          selectedPreset,
          nameBuffer,
          urlBuffer,
          showDetail,
          sessionFilterMode,
          sessionCursor,
          filteredSessions,
        ],
      ),
    );

    // -- Session browser view --
    if (step === "sessions") {
      const visibleStart = Math.max(0, sessionCursor - 10);
      const visibleSessions = filteredSessions.slice(visibleStart, visibleStart + 20);
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
              Continue session ({activeSessions.length} active
              {archivedCount > 0 ? `, ${archivedCount} archived` : ""})
            </text>
            {sessionFilterMode ? (
              <box flexDirection="row">
                <text color={theme.focus}>{"/ "}</text>
                <text>{sessionFilter}</text>
                <text color={theme.focus}>▌</text>
              </box>
            ) : null}
          </box>
          <box
            flexDirection="column"
            marginX={2}
            borderStyle="single"
            borderColor={theme.border}
            paddingX={1}
          >
            {visibleSessions.length === 0 ? (
              <text color={theme.dimmed}>
                {sessionFilter ? "No sessions match filter" : "No sessions"}
              </text>
            ) : null}
            {visibleSessions.map((s, i) => {
              const globalIdx = visibleStart + i;
              const selected = globalIdx === sessionCursor;
              const prefix = selected ? "> " : "  ";
              const icon = s.status === "active" ? "●" : "○";
              const goal = (s.goal ?? "untitled").slice(0, 50);
              const date = s.startedAt
                ? new Date(s.startedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                : "";
              return (
                <box
                  key={s.sessionId}
                  flexDirection="row"
                  backgroundColor={selected ? theme.selectedBg : undefined}
                >
                  <text
                    color={
                      selected ? theme.focus : s.status === "active" ? theme.text : theme.dimmed
                    }
                    bold={selected}
                  >
                    {`${prefix}${icon} "${goal}"`}
                  </text>
                  <text color={theme.muted}>{` (${s.contributionCount}c) ${date}`}</text>
                </box>
              );
            })}
          </box>
          <box paddingX={2}>
            <text color={theme.dimmed}>j/k:navigate Enter:continue /:search Esc:back</text>
          </box>
        </box>
      );
    }

    // -- Connect URL input view --
    if (step === "connect") {
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
              Connect to remote Nexus
            </text>
            <text color={theme.muted}>{""}</text>
            <box flexDirection="row">
              <text color={theme.text}>Nexus URL: </text>
              <text color={theme.focus} bold>
                {urlBuffer}
              </text>
              <text color={theme.focus}>_</text>
            </box>
            <text color={theme.muted}>{""}</text>
            <text color={theme.dimmed}>Enter:connect Esc:back Backspace:delete</text>
          </box>
        </box>
      );
    }

    // -- Name input view --
    if (step === "name") {
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
              Name your grove
            </text>
            <text color={theme.muted}>Preset: {selectedPreset}</text>
            <text color={theme.muted}>{""}</text>
            <box flexDirection="row">
              <text color={theme.text}>Grove name: </text>
              <text color={theme.focus} bold>
                {nameBuffer}
              </text>
              <text color={theme.focus}>_</text>
            </box>
            <text color={theme.muted}>{""}</text>
            <text color={theme.dimmed}>Enter:confirm Esc:back Backspace:delete</text>
          </box>
        </box>
      );
    }

    // -- Preset selection view --
    if (step === "preset") {
      return (
        <box
          flexDirection="column"
          width="100%"
          height="100%"
          borderStyle="round"
          borderColor={theme.focus}
        >
          {/* Banner */}
          <box flexDirection="column" paddingX={2} paddingTop={1}>
            <text color={theme.focus} bold>
              Select a preset
            </text>
            <text color={theme.muted}>{""}</text>
          </box>

          {/* Preset list */}
          <box
            flexDirection="column"
            marginX={2}
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

          {/* Detail overlay for selected preset */}
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
                    <text
                      // biome-ignore lint/suspicious/noArrayIndexKey: detail lines have no stable identity
                      key={i}
                      color={theme.muted}
                    >
                      {line}
                    </text>
                  ))}
                </box>
              ) : null}
              <text color={theme.dimmed}>Press ? to close details</text>
            </box>
          ) : null}

          {/* Keyboard hints */}
          <box paddingX={2} marginTop={1}>
            <text color={theme.dimmed}>j/k:navigate Enter:select ?:details Esc:back</text>
          </box>
        </box>
      );
    }

    // -- Action selection view (setup screen) --
    return (
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        borderStyle="round"
        borderColor={theme.focus}
      >
        {/* Banner */}
        <box flexDirection="column" paddingX={2} paddingTop={1}>
          <text color={theme.focus} bold>
            Grove
          </text>
          <text color={theme.muted}>{""}</text>
        </box>

        {/* Action menu */}
        <box
          flexDirection="column"
          marginX={2}
          borderStyle="single"
          borderColor={theme.border}
          paddingX={1}
        >
          {actions.map((action, i) => {
            const selected = i === cursor;
            const prefix = selected ? "> " : "  ";
            return (
              <text
                key={action.id}
                color={selected ? theme.focus : theme.text}
                backgroundColor={selected ? theme.selectedBg : undefined}
                bold={selected}
              >
                {prefix}
                {action.label}
              </text>
            );
          })}
        </box>

        {/* Recent sessions (shown when grove exists and has sessions) */}
        {groveExists && sessions && sessions.length > 0 ? (
          <box
            flexDirection="column"
            marginX={2}
            marginTop={1}
            borderStyle="single"
            borderColor={theme.border}
            paddingX={1}
          >
            <text color={theme.focus} bold>
              Sessions ({activeSessions.length} active
              {archivedCount > 0 ? `, ${archivedCount} archived` : ""})
            </text>
            {sessions.slice(0, 5).map((s, _i) => (
              <text key={s.sessionId} color={s.status === "active" ? theme.text : theme.dimmed}>
                {"  "}
                {s.status === "active" ? "●" : "○"} {`"${(s.goal ?? "untitled").slice(0, 50)}"`}
                <text color={theme.muted}> ({s.contributionCount}c)</text>
              </text>
            ))}
          </box>
        ) : null}

        {/* Concept glossary */}
        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="single"
          borderColor={theme.border}
          paddingX={1}
        >
          <text color={theme.focus} bold>
            What is Grove?
          </text>
          <text color={theme.text}>A multi-agent collaboration workspace.</text>
          <text color={theme.text}>Agents work together on a shared contribution graph</text>
          <text color={theme.text}>with human oversight.</text>
          <text color={theme.muted}>{""}</text>
          {GLOSSARY.map((entry) => (
            <box key={entry.term} flexDirection="row">
              <text color={theme.text}>{"  "}</text>
              <text color={theme.info}>{entry.term.padEnd(16)}</text>
              <text color={theme.muted}>{entry.definition}</text>
            </box>
          ))}
        </box>

        {/* Keyboard hints */}
        <box paddingX={2} marginTop={1}>
          <text color={theme.dimmed}>[Enter] select [j/k] navigate [q] quit</text>
        </box>
      </box>
    );
  },
);
