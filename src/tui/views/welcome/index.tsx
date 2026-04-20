/**
 * Welcome screen entry point.
 *
 * Picks between fast-path (returning operator) and first-run (new user)
 * via `resolveInitialRoute`, and routes sub-views (connect, new-session)
 * on demand. Exports `WelcomeScreen` as a drop-in replacement for the old
 * `views/welcome.tsx` export.
 */

import React, { useState } from "react";
import type { SessionRecord } from "../../provider.js";
import type { TuiPresetEntry } from "../../tui-app.js";
import { Connect } from "./connect.js";
import type { KeymapChoice } from "./customize-keyboard.js";
import { FastPath } from "./fast-path.js";
import { FirstRun } from "./first-run.js";
import { NewSession } from "./new-session.js";
import {
  resolveInitialRoute,
  type WelcomeMode,
  type WelcomeRoute,
} from "./router.js";

export interface WelcomeProps {
  readonly presets: readonly TuiPresetEntry[];
  readonly groveExists: boolean;
  readonly groveInfo?: { name: string; preset: string } | undefined;
  readonly sessions?: readonly SessionRecord[] | undefined;
  readonly connectError?: string | undefined;
  /**
   * Seed URL for the Connect sub-view — set to the last-attempted value when
   * a prior connect failed and the operator bounced back to setup via Esc,
   * so their typed URL isn't lost across the unmount.
   */
  readonly initialNexusUrl?: string | undefined;
  readonly onSelect: (args: {
    preset: string;
    name: string;
    mode: WelcomeMode;
    keymap: KeymapChoice;
  }) => void;
  readonly onResume: (sessionId: string) => void;
  readonly onNewSession: (presetName: string) => void;
  readonly onConnect: (nexusUrl: string) => void;
  readonly onQuit: () => void;
}

export const WelcomeScreen: React.NamedExoticComponent<WelcomeProps> = React.memo(
  function WelcomeScreen({
    presets,
    groveExists,
    groveInfo,
    sessions,
    connectError,
    initialNexusUrl,
    onSelect,
    onResume,
    onNewSession,
    onConnect,
    onQuit,
  }: WelcomeProps): React.ReactNode {
    const [route, setRoute] = useState<WelcomeRoute>(() =>
      resolveInitialRoute({ groveExists, sessions: sessions ?? [], groveInfo }),
    );

    const groveName = groveInfo?.name ?? "grove";

    if (route.kind === "connect") {
      return (
        <Connect
          error={connectError}
          initialUrl={initialNexusUrl}
          onConnect={(url) => onConnect(url)}
          onBack={() =>
            setRoute(
              route.returnTo === "fast-path"
                ? { kind: "fast-path" }
                : { kind: "first-run" },
            )
          }
        />
      );
    }

    if (route.kind === "new-session") {
      return (
        <NewSession
          groveName={groveName}
          presets={presets}
          onPick={(name) => onNewSession(name)}
          onBack={() => setRoute({ kind: "fast-path" })}
          onQuit={onQuit}
        />
      );
    }

    if (route.kind === "first-run") {
      return (
        <FirstRun
          presets={presets}
          onSelect={(args) => onSelect(args)}
          onConnect={() => setRoute({ kind: "connect", returnTo: "first-run" })}
          onQuit={onQuit}
        />
      );
    }

    // fast-path
    return (
      <FastPath
        groveName={groveName}
        sessions={sessions ?? []}
        onResume={onResume}
        onNewSession={() => setRoute({ kind: "new-session" })}
        onConnect={() => setRoute({ kind: "connect", returnTo: "fast-path" })}
        onQuit={onQuit}
      />
    );
  },
);
