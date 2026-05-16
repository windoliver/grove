/**
 * Walks the SupervisionScreen keyboard router through a typical
 * operator session at the action level — fast and deterministic.
 *
 * No React mount, no provider. Higher-fidelity scenarios live in
 * supervision-snapshot.test.ts and (eventually) the tmux real-grove
 * harness.
 */

import { describe, expect, test } from "bun:test";
import { routeKey } from "../../src/tui/views/supervision/keyboard.js";

describe("operator session walk-through", () => {
  test("filter → next approval → accept → drill → cycle tabs → quit", () => {
    let drill = false;
    let modal = false;
    let cmd: "idle" | "filter" = "idle";

    // 1. enter filter
    expect(
      routeKey("/", {
        modalOpen: modal,
        focusedAgentAwaiting: false,
        drillOpen: drill,
        cmdMode: cmd,
      }),
    ).toEqual({ kind: "enter-filter" });
    cmd = "filter";

    // 2. type 'r'
    expect(
      routeKey("r", {
        modalOpen: modal,
        focusedAgentAwaiting: false,
        drillOpen: drill,
        cmdMode: cmd,
      }),
    ).toEqual({ kind: "cmd-mode-char", char: "r" });

    // 3. Esc out of filter
    expect(
      routeKey("Escape", {
        modalOpen: modal,
        focusedAgentAwaiting: false,
        drillOpen: drill,
        cmdMode: cmd,
      }),
    ).toEqual({ kind: "exit-cmd-mode" });
    cmd = "idle";

    // 4. A → open next approval
    expect(
      routeKey("A", {
        modalOpen: modal,
        focusedAgentAwaiting: false,
        drillOpen: drill,
        cmdMode: cmd,
      }),
    ).toEqual({ kind: "open-next-approval" });
    modal = true;

    // 5. y → accept
    expect(
      routeKey("y", {
        modalOpen: modal,
        focusedAgentAwaiting: false,
        drillOpen: drill,
        cmdMode: cmd,
      }),
    ).toEqual({ kind: "accept-approval" });
    modal = false;

    // 6. Enter → open drill
    expect(
      routeKey("Enter", {
        modalOpen: modal,
        focusedAgentAwaiting: false,
        drillOpen: drill,
        cmdMode: cmd,
      }),
    ).toEqual({ kind: "open-drill" });
    drill = true;

    // 7. Tab → cycle drill tab
    expect(
      routeKey("Tab", {
        modalOpen: modal,
        focusedAgentAwaiting: false,
        drillOpen: drill,
        cmdMode: cmd,
      }),
    ).toEqual({ kind: "cycle-drill-tab" });

    // 8. 2 → set drill tab to dag
    expect(
      routeKey("2", {
        modalOpen: modal,
        focusedAgentAwaiting: false,
        drillOpen: drill,
        cmdMode: cmd,
      }),
    ).toEqual({ kind: "set-drill-tab", tab: "dag" });

    // 9. Esc → close drill
    expect(
      routeKey("Escape", {
        modalOpen: modal,
        focusedAgentAwaiting: false,
        drillOpen: drill,
        cmdMode: cmd,
      }),
    ).toEqual({ kind: "close-drill" });
  });
});
