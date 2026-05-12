/**
 * Pure state reducer for the running-view C2 command/filter prompt.
 * No React, no IO — testable as plain functions.
 */

import type { PromptMode } from "../components/prompt.js";

export interface CmdModeState {
  readonly mode: PromptMode;
  readonly text: string;
  readonly suggestionIndex: number;
}

export const initialCmdState: CmdModeState = {
  mode: "none",
  text: "",
  suggestionIndex: 0,
};

export function enterGoto(_s: CmdModeState): CmdModeState {
  return { mode: "goto", text: "", suggestionIndex: 0 };
}

export function enterFilter(_s: CmdModeState): CmdModeState {
  return { mode: "filter", text: "", suggestionIndex: 0 };
}

export function appendChar(s: CmdModeState, ch: string): CmdModeState {
  return { ...s, text: s.text + ch, suggestionIndex: 0 };
}

export function deleteChar(s: CmdModeState): CmdModeState {
  if (s.text.length === 0) return s;
  return { ...s, text: s.text.slice(0, -1) };
}

export function exitCmdMode(_s: CmdModeState): CmdModeState {
  return { mode: "none", text: "", suggestionIndex: 0 };
}

export function cycleSuggestion(s: CmdModeState, total: number): CmdModeState {
  if (total <= 0) return s;
  return { ...s, suggestionIndex: (s.suggestionIndex + 1) % total };
}
