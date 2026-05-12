import { describe, expect, test } from "bun:test";

import type { CmdModeState } from "./running-cmd-mode.js";
import {
  appendChar,
  cycleSuggestion,
  deleteChar,
  enterFilter,
  enterGoto,
  exitCmdMode,
  initialCmdState,
} from "./running-cmd-mode.js";

describe("running-cmd-mode reducer", () => {
  test("initial state is none", () => {
    expect(initialCmdState).toEqual({
      mode: "none",
      text: "",
      suggestionIndex: 0,
    });
  });

  test("enterGoto sets mode='goto' and clears text", () => {
    const s: CmdModeState = { mode: "filter", text: "stale", suggestionIndex: 3 };
    expect(enterGoto(s)).toEqual({ mode: "goto", text: "", suggestionIndex: 0 });
  });

  test("enterFilter sets mode='filter' and clears text", () => {
    const s: CmdModeState = { mode: "goto", text: "abc", suggestionIndex: 2 };
    expect(enterFilter(s)).toEqual({ mode: "filter", text: "", suggestionIndex: 0 });
  });

  test("appendChar appends to text and resets suggestion index", () => {
    const s: CmdModeState = { mode: "goto", text: "ag", suggestionIndex: 2 };
    expect(appendChar(s, "e")).toEqual({ mode: "goto", text: "age", suggestionIndex: 0 });
  });

  test("deleteChar removes last char", () => {
    const s: CmdModeState = { mode: "goto", text: "abc", suggestionIndex: 0 };
    expect(deleteChar(s)).toEqual({ mode: "goto", text: "ab", suggestionIndex: 0 });
  });

  test("deleteChar on empty text is a no-op", () => {
    const s: CmdModeState = { mode: "goto", text: "", suggestionIndex: 0 };
    expect(deleteChar(s)).toEqual(s);
  });

  test("exitCmdMode returns mode='none' and clears text", () => {
    const s: CmdModeState = { mode: "goto", text: "abc", suggestionIndex: 2 };
    expect(exitCmdMode(s)).toEqual({ mode: "none", text: "", suggestionIndex: 0 });
  });

  test("cycleSuggestion wraps within suggestion length", () => {
    const s: CmdModeState = { mode: "goto", text: "a", suggestionIndex: 1 };
    expect(cycleSuggestion(s, 3)).toEqual({ ...s, suggestionIndex: 2 });
    expect(cycleSuggestion({ ...s, suggestionIndex: 2 }, 3)).toEqual({ ...s, suggestionIndex: 0 });
  });

  test("cycleSuggestion with 0 length is a no-op", () => {
    const s: CmdModeState = { mode: "goto", text: "x", suggestionIndex: 0 };
    expect(cycleSuggestion(s, 0)).toEqual(s);
  });
});
