/**
 * First-run mode picker — two backend cards (Local vs Connected).
 *
 * Uses `routeModePickerKey` for all key handling. Glossary overlay is
 * toggleable via `?` and shares its copy with other first-run sub-views.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useRef, useState } from "react";
import { theme } from "../../theme.js";
import { GLOSSARY } from "./glossary.js";
import { routeModePickerKey } from "./mode-picker-keyboard.js";
import type { WelcomeMode } from "./router.js";

export interface ModePickerProps {
  readonly defaultPresetByMode: Readonly<Record<WelcomeMode, string | undefined>>;
  readonly onStartWithDefaults: (mode: WelcomeMode) => void;
  readonly onCustomize: (mode: WelcomeMode) => void;
  readonly onConnect: () => void;
  readonly onQuit: () => void;
}

export const ModePicker: React.NamedExoticComponent<ModePickerProps> = React.memo(
  function ModePicker({
    defaultPresetByMode,
    onStartWithDefaults,
    onCustomize,
    onConnect,
    onQuit,
  }: ModePickerProps): React.ReactNode {
    const [mode, setMode] = useState<WelcomeMode>("local");
    const [glossaryOpen, setGlossaryOpen] = useState(false);
    void useRenderer();

    // Refs mirror state so the keyboard handler sees current values even when
    // the callback itself was registered with older ones.
    const modeRef = useRef(mode);
    const glossaryOpenRef = useRef(glossaryOpen);
    modeRef.current = mode;
    glossaryOpenRef.current = glossaryOpen;

    useKeyboard(
      useCallback(
        (key) => {
          routeModePickerKey(
            key,
            { mode: modeRef.current, glossaryOpen: glossaryOpenRef.current },
            {
              setMode,
              startWithDefaults: () => onStartWithDefaults(modeRef.current),
              goToCustomize: () => onCustomize(modeRef.current),
              openConnect: onConnect,
              toggleGlossary: () => setGlossaryOpen((v) => !v),
              onQuit,
            },
          );
        },
        [onStartWithDefaults, onCustomize, onConnect, onQuit],
      ),
    );

    const localPreset = defaultPresetByMode.local ?? "—";
    const connectedPreset = defaultPresetByMode.connected ?? "—";

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
            Welcome to Grove
          </text>
          <text color={theme.secondary}>{""}</text>
          <text color={theme.text}>Multi-agent collaboration workspace.</text>
          <text color={theme.secondary}>{""}</text>
        </box>

        <box flexDirection="row" marginX={2} marginTop={1}>
          <ModeCard
            title="Local"
            line1="Single host"
            line2="Fast iteration"
            preset={localPreset}
            focused={mode === "local"}
          />
          <text color={theme.secondary}>{"  "}</text>
          <ModeCard
            title="Connected"
            line1="Join a Nexus"
            line2="Team workspace"
            preset={connectedPreset}
            focused={mode === "connected"}
          />
        </box>

        <box paddingX={2} marginTop={1}>
          <text color={theme.secondary}>
            [h/l] move  [Enter] start with defaults  [Tab] customize  [c] connect to existing Nexus URL  [?] glossary  [q] quit
          </text>
        </box>

        {glossaryOpen ? (
          <box
            flexDirection="column"
            marginX={2}
            marginTop={1}
            borderStyle="round"
            borderColor={theme.info}
            paddingX={1}
          >
            <text color={theme.info} bold>
              Glossary
            </text>
            {GLOSSARY.map((entry) => (
              <box key={entry.term} flexDirection="row">
                <text color={theme.info}>{entry.term.padEnd(16)}</text>
                <text color={theme.secondary}>{entry.definition}</text>
              </box>
            ))}
            <text color={theme.secondary}>Press ? or Esc to close</text>
          </box>
        ) : null}
      </box>
    );
  },
);

// Inline card — kept private, no need to export.
function ModeCard(props: {
  title: string;
  line1: string;
  line2: string;
  preset: string;
  focused: boolean;
}): React.ReactNode {
  const { title, line1, line2, preset, focused } = props;
  return (
    <box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.focus : theme.border}
      paddingX={1}
    >
      <text color={focused ? theme.focus : theme.text} bold={focused}>
        {title}
      </text>
      <text color={theme.text}>{line1}</text>
      <text color={theme.text}>{line2}</text>
      <text color={theme.secondary}>{`Preset: ${preset}`}</text>
    </box>
  );
}
