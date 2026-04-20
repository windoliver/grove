/**
 * First-run customize screen — preset list, name input, keymap radio.
 *
 * Uses `routeCustomizeKey` for key routing and `applyKeymapPresetToFile`
 * on launch to persist the chosen keymap preset to the user's global
 * config.json (reusing the issue #195 config loader).
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import { homedir } from "node:os";
import { join } from "node:path";
import React, { useCallback, useState } from "react";
import { theme } from "../../theme.js";
import {
  type CustomizeField,
  type KeymapChoice,
  routeCustomizeKey,
} from "./customize-keyboard.js";
import { applyKeymapPresetToFile } from "./keymap-presets.js";
import type { WelcomeMode } from "./router.js";

export interface CustomizePresetEntry {
  readonly name: string;
  readonly description: string;
  readonly details?: string | undefined;
}

export interface CustomizeProps {
  readonly mode: WelcomeMode;
  readonly presets: readonly CustomizePresetEntry[];
  readonly defaultPresetName: string;
  readonly defaultName: string;
  readonly onLaunch: (args: { preset: string; name: string; keymap: KeymapChoice }) => void;
  readonly onBack: () => void;
}

function globalConfigPath(): string {
  return join(homedir(), ".config", "grove", "config.json");
}

export const Customize: React.NamedExoticComponent<CustomizeProps> = React.memo(
  function Customize({
    mode,
    presets,
    defaultPresetName,
    defaultName,
    onLaunch,
    onBack,
  }: CustomizeProps): React.ReactNode {
    const [field, setField] = useState<CustomizeField>("preset");
    const initialCursor = Math.max(0, presets.findIndex((p) => p.name === defaultPresetName));
    const [presetCursor, setPresetCursor] = useState(initialCursor);
    const [name, setName] = useState(defaultName);
    const [keymap, setKeymap] = useState<KeymapChoice>("vim");
    const [presetDetailOpen, setPresetDetailOpen] = useState(false);
    void useRenderer();

    const launch = useCallback(() => {
      const preset = presets[presetCursor]?.name ?? defaultPresetName;
      void (async () => {
        if (keymap !== "none") {
          try {
            await applyKeymapPresetToFile(keymap, globalConfigPath());
          } catch (err) {
            process.stderr.write(
              `[grove] failed to apply keymap preset "${keymap}": ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        onLaunch({ preset, name, keymap });
      })();
    }, [presets, presetCursor, defaultPresetName, keymap, name, onLaunch]);

    useKeyboard(
      useCallback(
        (key) => {
          routeCustomizeKey(
            key,
            {
              field,
              presetCursor,
              presetCount: presets.length,
              name,
              keymap,
              presetDetailOpen,
            },
            {
              setField,
              setPresetCursor,
              setName,
              setKeymap,
              togglePresetDetail: () => setPresetDetailOpen((v) => !v),
              goBack: onBack,
              launch,
            },
          );
        },
        [field, presetCursor, presets.length, name, keymap, presetDetailOpen, onBack, launch],
      ),
    );

    const focusedPreset = presets[presetCursor];

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
            Customize
          </text>
          <text color={theme.secondary}>{`Mode: ${mode === "local" ? "Local" : "Connected"}`}</text>
          <text color={theme.secondary}>{""}</text>
        </box>

        {/* Preset field */}
        <box
          flexDirection="column"
          marginX={2}
          borderStyle="round"
          borderColor={field === "preset" ? theme.focus : theme.border}
          paddingX={1}
        >
          <text color={theme.text} bold>
            Preset
          </text>
          {presets.map((p, i) => {
            const selected = i === presetCursor;
            const prefix = selected ? "> " : "  ";
            return (
              <box
                key={p.name}
                flexDirection="row"
                backgroundColor={selected && field === "preset" ? theme.selectedBg : undefined}
              >
                <text color={selected ? theme.focus : theme.text} bold={selected}>
                  {`${prefix}${p.name.padEnd(20)}`}
                </text>
                <text color={theme.secondary}>{p.description}</text>
              </box>
            );
          })}
        </box>

        {/* Name field */}
        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="round"
          borderColor={field === "name" ? theme.focus : theme.border}
          paddingX={1}
        >
          <text color={theme.text} bold>
            Name
          </text>
          <box flexDirection="row">
            <text color={theme.focus} bold>
              {name}
            </text>
            {field === "name" ? <text color={theme.focus}>_</text> : null}
          </box>
        </box>

        {/* Keymap field */}
        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="round"
          borderColor={field === "keymap" ? theme.focus : theme.border}
          paddingX={1}
        >
          <text color={theme.text} bold>
            Keymap
          </text>
          <box flexDirection="row">
            {(["vim", "emacs", "none"] as const).map((c) => (
              <text
                key={c}
                color={c === keymap ? theme.focus : theme.text}
                bold={c === keymap}
              >
                {`${c === keymap ? "(•) " : "( ) "}${c}   `}
              </text>
            ))}
          </box>
        </box>

        {/* Preset detail overlay */}
        {presetDetailOpen && focusedPreset ? (
          <box
            flexDirection="column"
            marginX={2}
            marginTop={1}
            borderStyle="round"
            borderColor={theme.info}
            paddingX={1}
          >
            <text color={theme.info} bold>
              {focusedPreset.name}
            </text>
            <text color={theme.text}>{focusedPreset.description}</text>
            {focusedPreset.details
              ? focusedPreset.details.split("\n").map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: detail lines have no stable identity
                  <text key={i} color={theme.secondary}>
                    {line}
                  </text>
                ))
              : null}
            <text color={theme.secondary}>Press ? to close</text>
          </box>
        ) : null}

        <box paddingX={2} marginTop={1}>
          <text color={theme.secondary}>
            [j/k] preset  [Tab] field  [Enter] launch  [?] details  [Esc] back
          </text>
        </box>
      </box>
    );
  },
);
