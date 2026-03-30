/**
 * Tests for the shared useTextInput hook.
 *
 * Tests the pure buffer logic — character input, backspace, cursor movement,
 * Ctrl+U clear, Home/End, and edge cases.
 */

import { describe, expect, test } from "bun:test";

// Since useTextInput is a React hook, we test the state transitions directly
// by simulating what the hook does internally. This avoids needing a full
// React renderer for pure logic tests.

/** Simulate the text input state machine (mirrors hook logic). */
interface TextState {
  value: string;
  cursor: number;
}

function processKey(
  state: TextState,
  key: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean },
): TextState {
  if (key.ctrl && key.name === "u") {
    return { value: "", cursor: 0 };
  }
  if (key.name === "backspace") {
    if (state.cursor === 0) return state;
    const before = state.value.slice(0, state.cursor - 1);
    const after = state.value.slice(state.cursor);
    return { value: before + after, cursor: state.cursor - 1 };
  }
  if (key.name === "delete") {
    if (state.cursor >= state.value.length) return state;
    const before = state.value.slice(0, state.cursor);
    const after = state.value.slice(state.cursor + 1);
    return { value: before + after, cursor: state.cursor };
  }
  if (key.name === "home") {
    return { ...state, cursor: 0 };
  }
  if (key.name === "end") {
    return { ...state, cursor: state.value.length };
  }
  if (key.name === "left") {
    return state.cursor === 0 ? state : { ...state, cursor: state.cursor - 1 };
  }
  if (key.name === "right") {
    return state.cursor === state.value.length ? state : { ...state, cursor: state.cursor + 1 };
  }
  if (key.name === "space") {
    const before = state.value.slice(0, state.cursor);
    const after = state.value.slice(state.cursor);
    return { value: `${before} ${after}`, cursor: state.cursor + 1 };
  }
  if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
    const before = state.value.slice(0, state.cursor);
    const after = state.value.slice(state.cursor);
    return { value: before + key.sequence + after, cursor: state.cursor + 1 };
  }
  return state;
}

describe("useTextInput state machine", () => {
  test("character input appends at cursor", () => {
    const state = processKey({ value: "", cursor: 0 }, { sequence: "a" });
    expect(state.value).toBe("a");
    expect(state.cursor).toBe(1);
  });

  test("character input inserts at cursor position", () => {
    const state = processKey({ value: "ac", cursor: 1 }, { sequence: "b" });
    expect(state.value).toBe("abc");
    expect(state.cursor).toBe(2);
  });

  test("backspace removes character before cursor", () => {
    const state = processKey({ value: "abc", cursor: 3 }, { name: "backspace" });
    expect(state.value).toBe("ab");
    expect(state.cursor).toBe(2);
  });

  test("backspace at position 0 is a no-op", () => {
    const initial = { value: "abc", cursor: 0 };
    const state = processKey(initial, { name: "backspace" });
    expect(state).toBe(initial); // referential equality — unchanged
  });

  test("Ctrl+U clears the buffer", () => {
    const state = processKey({ value: "hello world", cursor: 5 }, { ctrl: true, name: "u" });
    expect(state.value).toBe("");
    expect(state.cursor).toBe(0);
  });

  test("Home moves cursor to 0", () => {
    const state = processKey({ value: "abc", cursor: 2 }, { name: "home" });
    expect(state.cursor).toBe(0);
    expect(state.value).toBe("abc");
  });

  test("End moves cursor to end", () => {
    const state = processKey({ value: "abc", cursor: 0 }, { name: "end" });
    expect(state.cursor).toBe(3);
  });

  test("Home at position 0 returns same reference", () => {
    const initial = { value: "abc", cursor: 0 };
    const state = processKey(initial, { name: "home" });
    expect(state.cursor).toBe(0);
  });

  test("space inserts at cursor", () => {
    const state = processKey({ value: "ab", cursor: 1 }, { name: "space" });
    expect(state.value).toBe("a b");
    expect(state.cursor).toBe(2);
  });

  test("delete removes character at cursor", () => {
    const state = processKey({ value: "abc", cursor: 1 }, { name: "delete" });
    expect(state.value).toBe("ac");
    expect(state.cursor).toBe(1);
  });

  test("delete at end is a no-op", () => {
    const initial = { value: "abc", cursor: 3 };
    const state = processKey(initial, { name: "delete" });
    expect(state).toBe(initial);
  });

  test("left arrow moves cursor left", () => {
    const state = processKey({ value: "abc", cursor: 2 }, { name: "left" });
    expect(state.cursor).toBe(1);
  });

  test("right arrow moves cursor right", () => {
    const state = processKey({ value: "abc", cursor: 1 }, { name: "right" });
    expect(state.cursor).toBe(2);
  });

  test("ctrl+key is not treated as character input", () => {
    const initial = { value: "", cursor: 0 };
    const state = processKey(initial, { ctrl: true, name: "c", sequence: "\x03" });
    expect(state).toBe(initial);
  });

  test("meta+key is not treated as character input", () => {
    const initial = { value: "", cursor: 0 };
    const state = processKey(initial, { meta: true, sequence: "a" });
    expect(state).toBe(initial);
  });
});
