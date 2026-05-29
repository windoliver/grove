/**
 * useAccentPulse — shared focus-change accent pulse (#192).
 *
 * Returns a boolean that flips true for ~`durationMs` each time `trigger`
 * changes, used by views to flash an accent (e.g. `pulse ? theme.warning :
 * theme.focus`) on the newly focused element. Extracted verbatim from
 * <DetailView> and <ArtifactPreviewView>, which duplicated this logic.
 *
 * Behavior contract (preserved precisely from the original views):
 * - Driven entirely from inside useEffect so a plain react-test-renderer
 *   mount/update is a no-op (no throw, no timer leak).
 * - Skips the initial mount / no-change re-renders: only pulses when `trigger`
 *   actually changes.
 * - Degrades to a static accent (pulse never sticks on) if `useTimeline` is
 *   unavailable at runtime.
 */

import * as OpenTuiReact from "@opentui/react";
import { useEffect, useRef, useState } from "react";

/**
 * Resolve `useTimeline` once at module load. In production the real
 * `@opentui/react` always exports it; under tests a leaked `mock.module`
 * (process-wide, not auto-restored) may replace the module with one that omits
 * `useTimeline`, which would make the call below `undefined(...)` and crash
 * render. Fall back to a no-op chainable so the pulse degrades to a static
 * accent rather than throwing — the hook is still called unconditionally.
 */
const useTimeline: typeof OpenTuiReact.useTimeline =
  OpenTuiReact.useTimeline ??
  (((): { add: () => unknown; play: () => unknown } => ({
    add: () => ({ add: () => ({ play: () => undefined }), play: () => undefined }),
    play: () => undefined,
  })) as unknown as typeof OpenTuiReact.useTimeline);

/**
 * Flash an accent for `durationMs` whenever `trigger` changes.
 *
 * @param trigger - A value (e.g. focused-section index or artifact index)
 *   whose change drives the pulse. The initial value never pulses.
 * @param durationMs - Pulse duration in milliseconds (default 150).
 * @returns `true` while pulsing, otherwise `false`.
 */
export function useAccentPulse(trigger: number | undefined, durationMs = 150): boolean {
  const timeline = useTimeline({ duration: durationMs });
  const [pulse, setPulse] = useState(false);
  const prevRef = useRef<number | undefined>(trigger);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `timeline` is deliberately excluded from the deps. @opentui/react returns a NEW Timeline instance every render, so including it would re-run this effect on the setPulse(true) re-render — cleanup would clearTimeout the fallback timer before it fires, then the effect early-returns (prevRef already equals trigger), leaving no timer and the pulse stuck on permanently. We only (re)pulse when `trigger`/`durationMs` change; the timeline captured at that point is the correct one to animate.
  useEffect(() => {
    const next = trigger;
    // Skip the initial mount / no-change re-renders: only pulse when the
    // trigger actually changes.
    if (prevRef.current === next) return;
    prevRef.current = next;
    setPulse(true);
    let cleared = false;
    const clear = (): void => {
      if (!cleared) {
        cleared = true;
        setPulse(false);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Drive a throwaway target so the renderer's animation engine runs the
      // clock; clear the accent when the tween completes.
      const target = { t: 0 };
      timeline
        .add(target, {
          t: 1,
          duration: durationMs,
          onUpdate: (anim: { targets: object[] }) => {
            const v = (anim.targets[0] as { t: number }).t;
            if (v >= 1) clear();
          },
        })
        .play();
    } catch {
      // useTimeline/engine unavailable — fall through to the timer fallback.
    }
    // Timer fallback guarantees the accent clears even without a live engine.
    timer = setTimeout(clear, durationMs + 20);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [trigger, durationMs]);
  return pulse;
}
