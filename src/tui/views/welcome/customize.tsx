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
import React, { useCallback, useRef, useState } from "react";
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
    const [keymapError, setKeymapError] = useState<string | undefined>(undefined);
    void useRenderer();

    // Pending* refs are updated synchronously inside the action wrappers so
    // rapid bursts (Tab+Tab, ?+k, typing+Enter) read the post-action value
    // rather than a stale render commit. `hasLaunchedRef` guards against
    // Enter being repeated before the component unmounts.
    const pendingFieldRef = useRef(field);
    const pendingPresetCursorRef = useRef(presetCursor);
    const pendingKeymapRef = useRef(keymap);
    const pendingNameRef = useRef(name);
    const pendingNameIsEmptyRef = useRef(name.length === 0);
    const pendingPresetDetailOpenRef = useRef(presetDetailOpen);
    const hasLaunchedRef = useRef(false);

    const launch = useCallback(() => {
      if (hasLaunchedRef.current) return;
      // Bail out defensively when presets failed to load — avoids passing
      // preset="" into the init flow which would crash executeInit.
      const idx = pendingPresetCursorRef.current;
      const preset = presets[idx]?.name ?? defaultPresetName;
      if (!preset) return;
      const nameAtLaunch = pendingNameRef.current;
      const keymapAtLaunch = pendingKeymapRef.current;
      hasLaunchedRef.current = true;
      setKeymapError(undefined);
      void (async () => {
        if (keymapAtLaunch !== "none") {
          try {
            await applyKeymapPresetToFile(keymapAtLaunch, globalConfigPath());
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Reset guard so the operator can switch to "none" and retry
            // rather than being silently stuck on a failed launch.
            hasLaunchedRef.current = false;
            setKeymapError(msg);
            return;
          }
        }
        onLaunch({ preset, name: nameAtLaunch, keymap: keymapAtLaunch });
      })();
    }, [presets, defaultPresetName, onLaunch]);

    useKeyboard(
      useCallback(
        (key) => {
          routeCustomizeKey(
            key,
            {
              field: pendingFieldRef.current,
              presetCursor: pendingPresetCursorRef.current,
              presetCount: presets.length,
              nameIsEmpty: pendingNameIsEmptyRef.current,
              keymap: pendingKeymapRef.current,
              presetDetailOpen: pendingPresetDetailOpenRef.current,
            },
            {
              setField: (f) => {
                pendingFieldRef.current = f;
                setField(f);
              },
              movePresetCursor: (delta) => {
                const max = Math.max(0, presets.length - 1);
                const next = Math.max(0, Math.min(pendingPresetCursorRef.current + delta, max));
                pendingPresetCursorRef.current = next;
                setPresetCursor(next);
              },
              appendNameChar: (c) => {
                const next = pendingNameRef.current + c;
                pendingNameRef.current = next;
                pendingNameIsEmptyRef.current = next.length === 0;
                setName(next);
              },
              deleteNameChar: () => {
                const next = pendingNameRef.current.slice(0, -1);
                pendingNameRef.current = next;
                pendingNameIsEmptyRef.current = next.length === 0;
                setName(next);
              },
              setKeymap: (c) => {
                pendingKeymapRef.current = c;
                setKeymap(c);
              },
              togglePresetDetail: () => {
                const next = !pendingPresetDetailOpenRef.current;
                pendingPresetDetailOpenRef.current = next;
                setPresetDetailOpen(next);
              },
              goBack: onBack,
              launch,
            },
          );
        },
        [presets.length, onBack, launch],
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
          <text color={theme.secondary}>Mode: {mode === "local" ? "Local" : "Connected"}</text>
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
            <text color={theme.secondary}>Press ? or Esc to close</text>
          </box>
        ) : null}

        {keymapError ? (
          <box flexDirection="column" marginX={2} marginTop={1}>
            <text color={theme.error}>
              {`Keymap preset "${keymap}" failed: ${keymapError}`}
            </text>
            <text color={theme.secondary}>
              Switch Keymap to "none" (press 3) and press Enter to continue, or Esc to go back.
            </text>
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
