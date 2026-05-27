/**
 * Unit tests for use-keybinding-overrides.ts.
 *
 * Tests the loader, map builder, and routeKey integration path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { KeyEvent } from "@opentui/core";
import { resolveKeymapWithOverrides } from "../keymap/keymap.js";
import { loadKeybindings, REMAPPABLE_ACTIONS } from "./use-keybinding-overrides.js";
import type { KeyboardActions } from "./use-keyboard-handler.js";
import { routeKey } from "./use-keyboard-handler.js";
import type { PanelFocusState } from "./use-panel-focus.js";
import { InputMode, Panel } from "./use-panel-focus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let origCwd: string;

beforeEach(async () => {
  origCwd = process.cwd();
  tmpDir = await mkdtemp(join(tmpdir(), "grove-kb-test-"));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(origCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

/** Write a .grove/keybindings.json file in the temp cwd. */
async function writeKeybindings(content: unknown): Promise<void> {
  await mkdir(join(tmpDir, ".grove"), { recursive: true });
  await writeFile(join(tmpDir, ".grove", "keybindings.json"), JSON.stringify(content), "utf-8");
}

function keyEvent(name: string, opts?: { ctrl?: boolean }): KeyEvent {
  return {
    name,
    ctrl: opts?.ctrl ?? false,
    shift: false,
    meta: false,
    alt: false,
    option: false,
    sequence: name,
    raw: name,
    eventType: "keypress",
    preventDefault: () => {
      /* noop */
    },
    stopPropagation: () => {
      /* noop */
    },
  } as unknown as KeyEvent;
}

function mockActions(overrides?: Partial<{ mode: InputMode; focused: Panel }>): KeyboardActions {
  const panelState: PanelFocusState = {
    focused: overrides?.focused ?? Panel.Dag,
    visibleOperator: new Set(),
    mode: overrides?.mode ?? InputMode.Normal,
    viewMode: "grid",
  };
  return {
    panels: {
      state: panelState,
      focus: () => {
        /* noop */
      },
      toggle: () => {
        /* noop */
      },
      cycleNext: () => {
        /* noop */
      },
      cyclePrev: () => {
        /* noop */
      },
      setMode: () => {
        /* noop */
      },
      cycleViewMode: () => {
        /* noop */
      },
      isVisible: () => true,
      visiblePanels: [],
    },
    nav: {
      state: { activeTab: 0, cursor: 0, pageOffset: 0, detailStack: [] },
      isDetailView: false,
      detailCid: undefined,
      switchTab: () => {
        /* noop */
      },
      cursorDown: () => {
        /* noop */
      },
      cursorUp: () => {
        /* noop */
      },
      pushDetail: () => {
        /* noop */
      },
      popDetail: () => {
        /* noop */
      },
      resetCursor: () => {
        /* noop */
      },
      nextPage: () => {
        /* noop */
      },
      prevPage: () => {
        /* noop */
      },
    },
    onQuit: () => {
      /* noop */
    },
    onSpawnPalette: () => {
      /* noop */
    },
    onPaletteClose: () => {
      /* noop */
    },
    onVfsNavigate: () => {
      /* noop */
    },
    onArtifactPrev: () => {
      /* noop */
    },
    onArtifactNext: () => {
      /* noop */
    },
    onArtifactDiffToggle: () => {
      /* noop */
    },
    onCompareToggle: () => {
      /* noop */
    },
    onCompareSelect: () => {
      /* noop */
    },
    onCompareAdopt: () => {
      /* noop */
    },
    onSearchStart: () => {
      /* noop */
    },
    onSearchSubmit: () => {
      /* noop */
    },
    onSearchChar: () => {
      /* noop */
    },
    onSearchBackspace: () => {
      /* noop */
    },
    onMessageSubmit: () => {
      /* noop */
    },
    onMessageChar: () => {
      /* noop */
    },
    onMessageBackspace: () => {
      /* noop */
    },
    onGoalSubmit: () => {
      /* noop */
    },
    onGoalChar: () => {
      /* noop */
    },
    onGoalBackspace: () => {
      /* noop */
    },
    onBroadcastMode: () => {
      /* noop */
    },
    onDirectMessageMode: () => {
      /* noop */
    },
    onApproveQuestion: () => {
      /* noop */
    },
    onDenyQuestion: () => {
      /* noop */
    },
    onSendKeys: () => {
      /* noop */
    },
    onPaletteUp: () => {
      /* noop */
    },
    onPaletteDown: () => {
      /* noop */
    },
    onPaletteSelect: () => {
      /* noop */
    },
    onPaletteChar: () => {
      /* noop */
    },
    onPaletteBackspace: () => {
      /* noop */
    },
    onZoomCycle: () => {
      /* noop */
    },
    onZoomReset: () => {
      /* noop */
    },
    onTerminalScrollUp: () => {
      /* noop */
    },
    onTerminalScrollDown: () => {
      /* noop */
    },
    onTerminalScrollBottom: () => {
      /* noop */
    },
    onLayoutToggle: () => {
      /* noop */
    },
    onRefresh: () => {
      /* noop */
    },
    onSelect: () => {
      /* noop */
    },
    rowCount: 10,
    pageSize: 20,
    paletteItemCount: 5,
    compareMode: false,
    frontierCids: () => [],
    frontierEntries: () => [],
    onFrontierTabNext: () => {
      /* noop */
    },
    onFrontierTabPrev: () => {
      /* noop */
    },
    onFrontierAdopt: () => {
      /* noop */
    },
    selectedSession: undefined,
    hasTmux: false,
  };
}

// ---------------------------------------------------------------------------
// loadKeybindings
// ---------------------------------------------------------------------------

describe("loadKeybindings", () => {
  test("returns empty object when file does not exist", async () => {
    const result = await loadKeybindings();
    expect(result).toEqual({});
  });

  test("happy path: loads valid action→key map", async () => {
    await writeKeybindings({ quit: "Q", help: "F1" });
    const result = await loadKeybindings();
    expect(result.quit).toBe("Q");
    expect(result.help).toBe("F1");
  });

  test("loads parameterized panel action ids", async () => {
    await writeKeybindings({ "toggle_panel:terminal": "Space p x" });
    const result = await loadKeybindings();

    expect(result["toggle_panel:terminal"]).toBe("Space p x");
  });

  test("silently ignores unknown action names", async () => {
    await writeKeybindings({ quit: "Q", nonexistent_action: "X" });
    const result = await loadKeybindings();
    expect(result.quit).toBe("Q");
    expect(result.nonexistent_action).toBeUndefined();
  });

  test("returns empty object on corrupt JSON", async () => {
    await mkdir(join(tmpDir, ".grove"), { recursive: true });
    await writeFile(join(tmpDir, ".grove", "keybindings.json"), "{ bad json", "utf-8");
    const result = await loadKeybindings();
    expect(result).toEqual({});
  });

  test("returns empty object when values are not strings (Zod validation)", async () => {
    // Zod rejects non-string values — whole file fails validation
    await writeKeybindings({ quit: 42 });
    const result = await loadKeybindings();
    expect(result).toEqual({});
  });

  test("loads all REMAPPABLE_ACTIONS correctly", async () => {
    const allActions: Record<string, string> = {};
    for (const action of REMAPPABLE_ACTIONS) {
      allActions[action] = `key-${action}`;
    }
    await writeKeybindings(allActions);
    const result = await loadKeybindings();
    for (const action of REMAPPABLE_ACTIONS) {
      expect(result[action]).toBe(`key-${action}`);
    }
  });
});

// ---------------------------------------------------------------------------
// legacy reverse map cleanup
// ---------------------------------------------------------------------------

describe("legacy reverse-map cleanup", () => {
  test("override module no longer exports the pre-keymap reverse map", () => {
    const source = readFileSync(resolve(import.meta.dir, "use-keybinding-overrides.ts"), "utf-8");

    expect(source).not.toContain("buildKeyActionMap");
    expect(source).not.toContain("DEFAULT_KEY_ACTIONS");
  });
});

// ---------------------------------------------------------------------------
// routeKey integration: override actually routes correctly
// ---------------------------------------------------------------------------

describe("routeKey — keybinding override integration", () => {
  test("remapped quit key triggers onQuit", () => {
    let quitCalled = false;
    const overrides = { quit: "Q" };
    const actions: KeyboardActions = {
      ...mockActions(),
      onQuit: () => {
        quitCalled = true;
      },
      resolvedKeymap: resolveKeymapWithOverrides("default", overrides),
    };

    const handled = routeKey(keyEvent("Q"), actions);
    expect(handled).toBe(true);
    expect(quitCalled).toBe(true);
  });

  test("non-overridden legacy key does not bypass the active keymap", () => {
    let quitCalled = false;
    const actions: KeyboardActions = {
      ...mockActions(),
      onQuit: () => {
        quitCalled = true;
      },
      resolvedKeymap: resolveKeymapWithOverrides("default", {}),
    };

    const handled = routeKey(keyEvent("q"), actions);
    expect(handled).toBe(false);
    expect(quitCalled).toBe(false);
  });
});
