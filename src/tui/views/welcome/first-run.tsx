/**
 * First-run container — routes between `ModePicker` and `Customize` based
 * on the user's Tab / Enter / back choices.
 */

import { basename } from "node:path";
import React, { useMemo, useState } from "react";
import type { TuiPresetEntry } from "../../tui-app.js";
import { Customize, type CustomizePresetEntry } from "./customize.js";
import type { KeymapChoice } from "./customize-keyboard.js";
import { ModePicker } from "./mode-picker.js";
import { resolveDefaultPreset, type WelcomeMode } from "./router.js";

export interface FirstRunProps {
  readonly presets: readonly TuiPresetEntry[];
  readonly cwd?: string;
  readonly onSelect: (args: {
    preset: string;
    name: string;
    mode: WelcomeMode;
    keymap: KeymapChoice;
  }) => void;
  readonly onConnect: () => void;
  readonly onQuit: () => void;
}

type Step = { readonly kind: "mode" } | { readonly kind: "customize"; readonly mode: WelcomeMode };

export const FirstRun: React.NamedExoticComponent<FirstRunProps> = React.memo(function FirstRun({
  presets,
  cwd,
  onSelect,
  onConnect,
  onQuit,
}: FirstRunProps): React.ReactNode {
  const [step, setStep] = useState<Step>({ kind: "mode" });

  const defaultPresetByMode = useMemo(
    () => ({
      local: resolveDefaultPreset("local", presets),
      connected: resolveDefaultPreset("connected", presets),
    }),
    [presets],
  );

  const defaultName = useMemo(() => {
    const cwdStr = cwd ?? process.cwd();
    return basename(cwdStr) || "my-grove";
  }, [cwd]);

  if (step.kind === "mode") {
    return (
      <ModePicker
        defaultPresetByMode={defaultPresetByMode}
        onStartWithDefaults={(mode) => {
          // Connected-mode defaults require a Nexus URL which we don't
          // have without user input — route through connect.tsx so the
          // user supplies it, rather than silently launching Local-style.
          if (mode === "connected") {
            onConnect();
            return;
          }
          const preset = defaultPresetByMode[mode];
          if (!preset) return;
          onSelect({ preset, name: defaultName, mode, keymap: "none" });
        }}
        onCustomize={(mode) => setStep({ kind: "customize", mode })}
        onConnect={onConnect}
        onQuit={onQuit}
      />
    );
  }

  const customizePresets: readonly CustomizePresetEntry[] = presets.map((p) => ({
    name: p.name,
    description: p.description,
    details: p.details,
  }));

  const defaultPreset = defaultPresetByMode[step.mode] ?? presets[0]?.name ?? "";

  return (
    <Customize
      mode={step.mode}
      presets={customizePresets}
      defaultPresetName={defaultPreset}
      defaultName={defaultName}
      onLaunch={({ preset, name, keymap }) => onSelect({ preset, name, mode: step.mode, keymap })}
      onBack={() => setStep({ kind: "mode" })}
      onQuit={onQuit}
    />
  );
});
