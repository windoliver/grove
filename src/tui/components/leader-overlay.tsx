import type React from "react";
import { formatKeySequence, type KeyBinding } from "../keymap/keymap.js";
import { type ChordCandidate, candidateContinuations } from "../keymap/leader-chord.js";
import { theme } from "../theme.js";

export interface LeaderOverlayProps {
  readonly prefix: readonly string[];
  readonly bindings: readonly KeyBinding[];
}

export function LeaderOverlay({ prefix, bindings }: LeaderOverlayProps): React.ReactNode {
  if (prefix.length === 0) return null;
  const candidates: readonly ChordCandidate[] = candidateContinuations(bindings, prefix);
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text color={theme.focus}>{formatKeySequence(prefix)} </text>
      {candidates.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: candidates are positional
        <text key={`${c.key}-${i}`} color={theme.secondary}>
          {`${c.key}:${c.label}  `}
        </text>
      ))}
    </box>
  );
}
