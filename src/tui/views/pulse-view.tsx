/**
 * PulseView — Pulse dashboard page (#308).
 *
 * Composes three Gauge rows (current AgentTask phase counts) and three
 * Sparkline rows (60s rolling rate). Gauges are read directly from the
 * aggregator snapshot (which itself reads them from the AgentTask
 * informer cache); sparklines come from the aggregator's ring buffers.
 *
 * The aggregator's lifecycle is owned by screen-manager; this view just
 * subscribes for the duration it's mounted.
 */

import { useKeyboard } from "@opentui/react";
import React, { useCallback, useSyncExternalStore } from "react";
import { Gauge } from "../components/gauge.js";
import { Sparkline } from "../components/sparkline.js";
import type { PulseAggregator } from "../data/pulse-aggregator.js";
import { theme } from "../theme.js";

export interface PulseViewProps {
  readonly aggregator: PulseAggregator;
  readonly active: boolean;
  /** Pop the Pulse page off the stack (Esc / Ctrl+G). Wired by screen-manager
   *  to `pages.pop()`. PagesRouter never pops on bare Esc — back is the
   *  inner screen's responsibility (see pages-router.tsx header). Without
   *  this the page is a navigation dead-end. */
  readonly onBack: () => void;
}

/** Minimal key shape consumed from @opentui's keyboard event. */
interface BackKey {
  readonly name?: string | undefined;
  readonly ctrl?: boolean | undefined;
}

/**
 * Pure predicate: does this key request leaving the Pulse page?
 *
 * Esc — intuitive back; safe here because PulseView is a leaf page
 * (RunningView is unmounted, no App modal cascade competes for Esc,
 * unlike InspectModeWrapper which wraps App and must avoid Esc).
 * Ctrl+G — mirrors the inspect-overlay back convention.
 *
 * Exported pure so it is unit-testable without an @opentui keyboard
 * harness (same philosophy as running-keyboard's routeRunningKey).
 */
export function isPulseBackKey(key: BackKey): boolean {
  return key.name === "escape" || (key.ctrl === true && key.name === "g");
}

export const PulseView: React.NamedExoticComponent<PulseViewProps> = React.memo(function PulseView({
  aggregator,
  onBack,
}: PulseViewProps): React.ReactNode {
  useKeyboard(
    useCallback(
      (key) => {
        if (isPulseBackKey(key)) {
          onBack();
        }
      },
      [onBack],
    ),
  );

  const snapshot = useSyncExternalStore(
    (fn) => aggregator.subscribe(fn),
    () => aggregator.getSnapshot(),
  );
  const { gauges, series } = snapshot;
  const max = Math.max(8, gauges.running + gauges.waitingApproval + gauges.failed);

  return (
    <box flexDirection="column" padding={1}>
      <text color={theme.secondary}>Tasks</text>
      <Gauge label="running" icon="●" color={theme.success} value={gauges.running} max={max} />
      <Gauge
        label="waiting-approval"
        icon="⏸"
        color={theme.warning}
        value={gauges.waitingApproval}
        max={max}
      />
      <Gauge label="failed" icon="✗" color={theme.error} value={gauges.failed} max={max} />

      <box marginTop={1}>
        <text color={theme.secondary}>Rates (last 60s)</text>
      </box>
      <box flexDirection="row">
        <text>{"spawn      ".padEnd(11, " ")}</text>
        <Sparkline values={series.spawnRate} color={theme.success} />
      </box>
      <box flexDirection="row">
        <text>{"events     ".padEnd(11, " ")}</text>
        <Sparkline values={series.eventRate} color={theme.info} />
      </box>
      <box flexDirection="row">
        <text>{"reviews    ".padEnd(11, " ")}</text>
        <Sparkline values={series.reviewIterations} color={theme.warning} />
      </box>

      <box marginTop={1}>
        <text color={theme.secondary}>Esc / Ctrl+G: back</text>
      </box>
    </box>
  );
});
