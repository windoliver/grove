/**
 * Shared text input hook — buffer-only.
 *
 * Handles character input, backspace, space, Ctrl+U (clear line),
 * Home/End cursor movement. Does NOT handle Enter, Esc, or mode
 * transitions — consumers handle those in their own keyboard routing.
 *
 * Replaces 5 independent text input implementations across:
 * - RunningView (promptText)
 * - WelcomeScreen (nameBuffer, urlBuffer, sessionFilter)
 * - App reducer (MESSAGE_CHAR, SEARCH_CHAR, GOAL_CHAR)
 */

import { useCallback, useState } from "react";

export interface TextInputState {
  /** Current buffer value. */
  readonly value: string;
  /** Cursor position (0-based index within value). */
  readonly cursor: number;
}

export interface TextInputActions {
  /** Current text value. */
  readonly value: string;
  /** Cursor position. */
  readonly cursor: number;
  /**
   * Process a keyboard event. Returns true if the key was handled.
   * Consumers should call this first, then check for Enter/Esc themselves.
   */
  readonly onKey: (key: {
    name?: string;
    sequence?: string;
    ctrl?: boolean;
    meta?: boolean;
  }) => boolean;
  /** Clear the buffer and reset cursor to 0. */
  readonly clear: () => void;
  /** Set the buffer to a specific value (cursor moves to end). */
  readonly setValue: (value: string) => void;
}

/**
 * Hook for text input buffer management.
 *
 * Usage:
 * ```tsx
 * const input = useTextInput("");
 * useKeyboard(useCallback((key) => {
 *   if (key.name === "return") { onSubmit(input.value); return; }
 *   if (key.name === "escape") { onCancel(); return; }
 *   input.onKey(key);
 * }, [input]));
 * ```
 */
export function useTextInput(initialValue = ""): TextInputActions {
  const [state, setState] = useState<TextInputState>({
    value: initialValue,
    cursor: initialValue.length,
  });

  const onKey = useCallback(
    (key: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }): boolean => {
      // Ctrl+U: clear line
      if (key.ctrl && key.name === "u") {
        setState({ value: "", cursor: 0 });
        return true;
      }

      // Backspace: delete char before cursor
      if (key.name === "backspace") {
        setState((s) => {
          if (s.cursor === 0) return s;
          const before = s.value.slice(0, s.cursor - 1);
          const after = s.value.slice(s.cursor);
          return { value: before + after, cursor: s.cursor - 1 };
        });
        return true;
      }

      // Delete: delete char at cursor
      if (key.name === "delete") {
        setState((s) => {
          if (s.cursor >= s.value.length) return s;
          const before = s.value.slice(0, s.cursor);
          const after = s.value.slice(s.cursor + 1);
          return { value: before + after, cursor: s.cursor };
        });
        return true;
      }

      // Home: move cursor to start
      if (key.name === "home") {
        setState((s) => (s.cursor === 0 ? s : { ...s, cursor: 0 }));
        return true;
      }

      // End: move cursor to end
      if (key.name === "end") {
        setState((s) => (s.cursor === s.value.length ? s : { ...s, cursor: s.value.length }));
        return true;
      }

      // Left arrow: move cursor left
      if (key.name === "left") {
        setState((s) => (s.cursor === 0 ? s : { ...s, cursor: s.cursor - 1 }));
        return true;
      }

      // Right arrow: move cursor right
      if (key.name === "right") {
        setState((s) => (s.cursor === s.value.length ? s : { ...s, cursor: s.cursor + 1 }));
        return true;
      }

      // Space
      if (key.name === "space") {
        setState((s) => {
          const before = s.value.slice(0, s.cursor);
          const after = s.value.slice(s.cursor);
          return { value: `${before} ${after}`, cursor: s.cursor + 1 };
        });
        return true;
      }

      // Printable character (single char, no ctrl/meta)
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        setState((s) => {
          const before = s.value.slice(0, s.cursor);
          const after = s.value.slice(s.cursor);
          return { value: before + key.sequence + after, cursor: s.cursor + 1 };
        });
        return true;
      }

      return false;
    },
    [],
  );

  const clear = useCallback(() => {
    setState({ value: "", cursor: 0 });
  }, []);

  const setValue = useCallback((value: string) => {
    setState({ value, cursor: value.length });
  }, []);

  return {
    value: state.value,
    cursor: state.cursor,
    onKey,
    clear,
    setValue,
  };
}
