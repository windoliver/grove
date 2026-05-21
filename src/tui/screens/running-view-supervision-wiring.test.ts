import { describe, expect, test } from "bun:test";
import { Supervision } from "./supervision/supervision.js";
import { supervisionInputActive } from "./supervision/supervision-input-guard.js";
import { routeSupervisionKey } from "./supervision/supervision-keyboard.js";
import { useFleetModel } from "./supervision/use-fleet-model.js";

// Task 10: GROVE_SUPERVISION flag wiring. We deliberately do NOT mount the
// heavy RunningView component (it transitively pulls config-watcher →
// chokidar, opentui, etc.). Instead we unit-test the extracted guard
// predicate `supervisionInputActive` — the SAME function the running-view
// keyboard owner calls (imported, not duplicated) — plus assert the three
// supervision modules are importable with the expected symbols.
// routeSupervisionKey itself is fully covered by its own test; not duplicated.

const clear = {
  useSupervision: true,
  expandedPanelNull: true,
  cmdMode: "none",
  promptMode: false,
  showHelp: false,
  showVfs: false,
  filterQuery: "",
} as const;

describe("supervisionInputActive guard predicate", () => {
  test("true when flag on and nothing else owns the keyboard", () => {
    expect(supervisionInputActive(clear)).toBe(true);
  });

  test("false when GROVE_SUPERVISION flag is off", () => {
    expect(supervisionInputActive({ ...clear, useSupervision: false })).toBe(false);
  });

  test("false when a panel is expanded (not the visible body)", () => {
    expect(supervisionInputActive({ ...clear, expandedPanelNull: false })).toBe(false);
  });

  test("false when cmd-mode owns input (filter/goto)", () => {
    expect(supervisionInputActive({ ...clear, cmdMode: "filter" })).toBe(false);
  });

  test("false when prompt mode, help, or vfs overlay is active", () => {
    expect(supervisionInputActive({ ...clear, promptMode: true })).toBe(false);
    expect(supervisionInputActive({ ...clear, showHelp: true })).toBe(false);
    expect(supervisionInputActive({ ...clear, showVfs: true })).toBe(false);
  });

  test("false when a live filter query is set", () => {
    expect(supervisionInputActive({ ...clear, filterQuery: "agent-x" })).toBe(false);
  });
});

describe("supervision modules are wired into running-view", () => {
  test("exports the expected symbols", () => {
    expect(typeof Supervision).toBe("object"); // React.memo component
    expect(typeof routeSupervisionKey).toBe("function");
    expect(typeof useFleetModel).toBe("function");
  });
});
