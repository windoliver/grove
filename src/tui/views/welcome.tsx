/**
 * Welcome screen view — shown when grove is launched without initialization.
 *
 * Two-step flow:
 *  1. Preset selection with j/k navigation, ? for detail overlay
 *  2. Name input (character-by-character) then Enter to confirm
 *
 * After name input, onSelect is called with (presetName, groveName).
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useState } from "react";
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
  /** Called with (presetName, groveName) after user completes both steps. */
  readonly onSelect: (presetName: string, groveName: string) => void;
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

type WelcomeStep = "preset" | "name";

/** Welcome screen shown when no .grove/ directory exists. */
export const WelcomeScreen: React.NamedExoticComponent<WelcomeProps> = React.memo(
  function WelcomeScreen({ presets, onSelect, onQuit }: WelcomeProps): React.ReactNode {
    const [cursor, setCursor] = useState(0);
    const [showDetail, setShowDetail] = useState(false);
    const [step, setStep] = useState<WelcomeStep>("preset");
    const [selectedPreset, setSelectedPreset] = useState("");
    const [nameBuffer, setNameBuffer] = useState("");
    void useRenderer();

    useKeyboard(
      useCallback(
        (key) => {
          const input = key.name;
          const isCtrl = key.ctrl;

          if (input === "q" && step === "preset" && !showDetail) {
            onQuit();
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
              // Default name from current directory
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
        },
        [presets, cursor, onSelect, onQuit, step, selectedPreset, nameBuffer, showDetail],
      ),
    );

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
            <box>
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
            Welcome to Grove
          </text>
          <text color={theme.muted}>{""}</text>
          <text color={theme.text}>Grove is a multi-agent collaboration workspace.</text>
          <text color={theme.text}>Agents work together on a shared contribution graph</text>
          <text color={theme.text}>with human oversight.</text>
        </box>

        {/* Quick Start — Preset list */}
        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="single"
          borderColor={theme.border}
          paddingX={1}
        >
          <text color={theme.focus} bold>
            Quick Start
          </text>
          {presets.map((preset, i) => {
            const selected = i === cursor;
            const prefix = selected ? "> " : "  ";
            return (
              <text
                key={preset.name}
                color={selected ? theme.focus : theme.text}
                backgroundColor={selected ? theme.selectedBg : undefined}
                bold={selected}
              >
                {prefix}
                {preset.name.padEnd(20)}
                <text color={theme.muted}>{preset.description}</text>
              </text>
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
            What is this?
          </text>
          {GLOSSARY.map((entry) => (
            <text key={entry.term} color={theme.text}>
              {"  "}
              <text color={theme.info}>{entry.term.padEnd(16)}</text>
              <text color={theme.muted}>{entry.definition}</text>
            </text>
          ))}
        </box>

        {/* Keyboard hints */}
        <box paddingX={2} marginTop={1}>
          <text color={theme.dimmed}>j/k:navigate Enter:select ?:details q:quit</text>
        </box>
      </box>
    );
  },
);
