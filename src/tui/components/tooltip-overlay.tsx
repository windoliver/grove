/**
 * First-launch tooltip overlay.
 *
 * Shows contextual tooltips over panels on first run. Dismissible
 * individually or all at once. Dismissal state persisted to
 * .grove/tui-state.json so tooltips don't reappear.
 */

import React, { useCallback, useEffect, useState } from "react";
import { theme } from "../theme.js";

/** Tooltip definition for a panel. */
export interface TooltipDef {
  /** Panel name (matches PANEL_LABELS keys). */
  readonly panel: string;
  /** Tooltip content lines. */
  readonly lines: readonly string[];
}

/** Default tooltips for first launch. */
export const FIRST_LAUNCH_TOOLTIPS: readonly TooltipDef[] = [
  {
    panel: "DAG",
    lines: [
      "This is the contribution graph.",
      "As agents work, their outputs",
      "appear here as connected nodes.",
    ],
  },
  {
    panel: "Detail",
    lines: [
      "Select a contribution in the DAG",
      "to see its full manifest, artifacts,",
      "and discussion threads.",
    ],
  },
  {
    panel: "Frontier",
    lines: [
      "The frontier ranks the best",
      "contributions by metric. Use this",
      "to track agent progress.",
    ],
  },
  {
    panel: "Claims",
    lines: [
      "Claims are lease-based locks that",
      "prevent agents from duplicating",
      "each other's work.",
    ],
  },
];

/** Props for the TooltipOverlay component. */
export interface TooltipOverlayProps {
  /** Whether to show tooltips. */
  readonly visible: boolean;
  /** Callback when all tooltips are dismissed. */
  readonly onDismissAll: () => void;
}

/** Path to persist tooltip dismissal state. */
const TUI_STATE_PATH = ".grove/tui-state.json";

/** Read tooltip dismissal state from disk. */
async function readTooltipState(): Promise<boolean> {
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const path = resolve(process.cwd(), TUI_STATE_PATH);
    const json = JSON.parse(readFileSync(path, "utf-8")) as { tooltipsDismissed?: boolean };
    return json.tooltipsDismissed === true;
  } catch {
    return false;
  }
}

/** Persist tooltip dismissal state to disk. */
async function writeTooltipState(): Promise<void> {
  try {
    const { existsSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const path = resolve(process.cwd(), TUI_STATE_PATH);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let state: Record<string, unknown> = {};
    try {
      const existing = JSON.parse((await import("node:fs")).readFileSync(path, "utf-8")) as Record<
        string,
        unknown
      >;
      state = existing;
    } catch {
      // File doesn't exist yet — start fresh
    }
    state.tooltipsDismissed = true;
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  } catch {
    // Best-effort — don't crash TUI if state can't be written
  }
}

/** Hook to manage first-launch tooltip state. */
export function useFirstLaunchTooltips(): {
  showTooltips: boolean;
  dismissAll: () => void;
} {
  const [show, setShow] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loaded) return;
    let cancelled = false;
    readTooltipState().then((dismissed) => {
      if (cancelled) return;
      setShow(!dismissed);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loaded]);

  const dismissAll = useCallback(() => {
    setShow(false);
    void writeTooltipState();
  }, []);

  // Don't show tooltips until we've read the persisted state — prevents
  // the race where tooltips flash in after an async read completes.
  return { showTooltips: loaded && show, dismissAll };
}

/** Overlay showing first-launch tooltips. */
export const TooltipOverlay: React.NamedExoticComponent<TooltipOverlayProps> = React.memo(
  function TooltipOverlay({
    visible,
    onDismissAll: _onDismissAll,
  }: TooltipOverlayProps): React.ReactNode {
    void _onDismissAll;
    if (!visible) return null;

    return (
      <box flexDirection="column" paddingLeft={2} paddingRight={2}>
        <box border borderStyle="round" borderColor={theme.info}>
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            <text color={theme.info} bold>
              Welcome to Grove!
            </text>
            <text color={theme.muted}>Here's a quick overview of each panel:</text>
            <text> </text>
            {FIRST_LAUNCH_TOOLTIPS.map((tip) => (
              <box key={tip.panel} flexDirection="column">
                <text color={theme.focus} bold>
                  {tip.panel}
                </text>
                {tip.lines.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tooltip lines are static
                  <text key={i} color={theme.muted}>
                    {"  "}
                    {line}
                  </text>
                ))}
                <text> </text>
              </box>
            ))}
            <text color={theme.dimmed}>Press any key to dismiss | These won't appear again</text>
          </box>
        </box>
      </box>
    );
  },
);
