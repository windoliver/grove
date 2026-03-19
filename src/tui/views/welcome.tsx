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
  /** Whether Nexus was auto-detected as available. */
  readonly nexusAvailable?: boolean | undefined;
  /** The auto-detected / persisted Nexus URL. */
  readonly detectedNexusUrl?: string | undefined;
  /** Called with (presetName, groveName) after user completes the "New grove" flow. */
  readonly onSelect: (presetName: string, groveName: string) => void;
  /** Called when user picks "Resume" to start the existing grove. */
  readonly onResume: () => void;
  /** Called with a Nexus URL when user completes the "Connect" flow. */
  readonly onConnect: (nexusUrl: string) => void;
  /** Called to create a new session (lightweight, no full init). */
  readonly onNewSession?: ((goal?: string) => void) | undefined;
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
  readonly id: "resume" | "new" | "connect" | "new-session";
  readonly label: string;
}

type WelcomeStep = "action" | "preset" | "name" | "connect" | "goal";

/** Welcome screen shown as the first thing the user sees. */
export const WelcomeScreen: React.NamedExoticComponent<WelcomeProps> = React.memo(
  function WelcomeScreen({
    presets,
    groveExists,
    groveInfo,
    sessions,
    nexusAvailable,
    detectedNexusUrl,
    onSelect,
    onResume,
    onConnect,
    onNewSession,
    onQuit,
  }: WelcomeProps): React.ReactNode {
    const [cursor, setCursor] = useState(0);
    const [showDetail, setShowDetail] = useState(false);
    const [step, setStep] = useState<WelcomeStep>("action");
    const [selectedPreset, setSelectedPreset] = useState("");
    const [nameBuffer, setNameBuffer] = useState("");
    const [urlBuffer, setUrlBuffer] = useState("http://localhost:2026");
    const [goalBuffer, setGoalBuffer] = useState("");
    void useRenderer();

    // Build action items dynamically based on Nexus availability + .grove/ state
    //
    // | Nexus? | .grove? | Actions shown |
    // |--------|---------|---------------|
    // | Yes    | Any     | Start new session, Resume (if sessions), Connect to different Nexus, New grove (local) |
    // | No     | Yes     | Resume, Start new session, Connect to Nexus, New grove (local, force) |
    // | No     | No      | Connect to Nexus, New grove (local) |
    const actions = useMemo<readonly ActionItem[]>(() => {
      const items: ActionItem[] = [];

      if (nexusAvailable) {
        // Nexus detected — "Start new session" is primary
        if (onNewSession) {
          items.push({ id: "new-session", label: "Start new session" });
        }
        if (groveExists && groveInfo) {
          items.push({ id: "resume", label: `Resume "${groveInfo.name}" (${groveInfo.preset})` });
        }
        items.push({ id: "connect", label: "Connect to different Nexus" });
        items.push({ id: "new", label: "New grove (local)" });
      } else if (groveExists) {
        // No Nexus, .grove/ exists
        if (groveInfo) {
          items.push({ id: "resume", label: `Resume "${groveInfo.name}" (${groveInfo.preset})` });
        }
        if (onNewSession) {
          items.push({ id: "new-session", label: "Start new session" });
        }
        items.push({ id: "connect", label: "Connect to Nexus" });
        items.push({ id: "new", label: "New grove (local, force)" });
      } else {
        // No Nexus, no .grove/
        items.push({ id: "connect", label: "Connect to Nexus" });
        items.push({ id: "new", label: "New grove (local)" });
      }

      return items;
    }, [groveExists, groveInfo, nexusAvailable, onNewSession]);

    useKeyboard(
      useCallback(
        (key) => {
          const input = key.name;
          const isCtrl = key.ctrl;

          if (input === "q" && step === "action" && !showDetail) {
            onQuit();
            return;
          }

          // -- Goal input step (Start new session) --
          if (step === "goal") {
            if (input === "escape") {
              setStep("action");
              setCursor(actions.findIndex((a) => a.id === "new-session"));
              return;
            }
            if (input === "return") {
              const goal = goalBuffer.trim() || undefined;
              onNewSession?.(goal);
              return;
            }
            if (input === "backspace") {
              setGoalBuffer((b) => b.slice(0, -1));
              return;
            }
            if (input && input.length === 1 && !isCtrl) {
              setGoalBuffer((b) => b + input);
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

              if (action.id === "resume") {
                onResume();
                return;
              }
              if (action.id === "new") {
                setCursor(0);
                setStep("preset");
                return;
              }
              if (action.id === "new-session") {
                setGoalBuffer("");
                setStep("goal");
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
          onNewSession,
          onQuit,
          step,
          selectedPreset,
          nameBuffer,
          urlBuffer,
          goalBuffer,
          showDetail,
        ],
      ),
    );

    // -- Goal input view (Start new session) --
    if (step === "goal") {
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
              Start new session
            </text>
            <text color={theme.muted}>{""}</text>
            <box flexDirection="row">
              <text color={theme.text}>Goal (optional): </text>
              <text color={theme.focus} bold>
                {goalBuffer}
              </text>
              <text color={theme.focus}>_</text>
            </box>
            <text color={theme.muted}>{""}</text>
            <text color={theme.dimmed}>Enter:start (empty=no goal) Esc:back Backspace:delete</text>
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

        {/* Nexus status line */}
        {nexusAvailable && detectedNexusUrl ? (
          <box paddingX={2}>
            <text color={theme.info}>
              Connected to Nexus at {detectedNexusUrl} (auto-detected)
            </text>
          </box>
        ) : null}

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
              Recent sessions
            </text>
            {sessions.slice(0, 5).map((s, i) => (
              <text key={s.sessionId} color={theme.text}>
                {"  "}
                {i + 1}. {`"${s.goal ?? "untitled"}"`}
                <text color={theme.muted}>
                  {" "}
                  ({s.contributionCount} contribution{s.contributionCount === 1 ? "" : "s"},{" "}
                  {s.status})
                </text>
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
