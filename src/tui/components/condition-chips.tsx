/**
 * ConditionChips — renders a Condition[] as a row of colored chips.
 *
 * Used in detail views to surface entity conditions (e.g. Ready, Expired).
 * Kind-agnostic: accepts any Condition from src/core/entity.ts.
 */

import React from "react";
import type { Condition, ConditionStatus } from "../../core/entity.js";
import { theme } from "../theme.js";

export interface ConditionChipsProps {
  readonly conditions: readonly Condition[];
}

/**
 * Negative-polarity condition types: "True" means something is wrong.
 * For these, the color mapping inverts (True=red, False=green) so a
 * healthy state ("Crashed=False") does not render as an error chip.
 *
 * Kept as a simple allowlist rather than a field on Condition so the
 * chip component stays consumer-only and adapters can keep emitting
 * plain Condition records.
 */
export const NEGATIVE_POLARITY_CONDITION_TYPES: ReadonlySet<string> = new Set([
  "Crashed",
  "Expired",
  "Failed",
  "Stalled",
  "Degraded",
  "Unreachable",
]);

export function colorForCondition(c: Condition): string {
  if (c.status === "Unknown") return theme.warning;
  const isNegative = NEGATIVE_POLARITY_CONDITION_TYPES.has(c.type);
  const isBad = isNegative ? c.status === "True" : c.status === "False";
  return isBad ? theme.error : theme.success;
}

/** @deprecated Use colorForCondition — raw status ignores condition polarity. */
export function colorForStatus(status: ConditionStatus): string {
  if (status === "True") return theme.success;
  if (status === "False") return theme.error;
  return theme.warning;
}

export function shouldShowReason(c: Condition): boolean {
  const isNegative = NEGATIVE_POLARITY_CONDITION_TYPES.has(c.type);
  const isHealthy = isNegative ? c.status === "False" : c.status === "True";
  return !isHealthy && (c.reason.length > 0 || c.message.length > 0);
}

export function conditionExplanation(c: Condition): string {
  if (c.reason.length === 0) return c.message;
  if (c.message.length === 0) return c.reason;
  return `${c.reason} — ${c.message}`;
}

export const ConditionChips: React.NamedExoticComponent<ConditionChipsProps> = React.memo(
  function ConditionChips({ conditions }: ConditionChipsProps): React.ReactNode {
    if (conditions.length === 0) return null;
    const reasons = conditions.filter(shouldShowReason);
    return (
      <box flexDirection="column" marginBottom={1}>
        <box flexDirection="row">
          {conditions.map((c, i) => (
            <React.Fragment key={c.type}>
              {i > 0 && <text> </text>}
              {/*
                OpenTUI renders a stable chip background when it lives on a
                <box>, but text-level backgroundColor is not always honored
                by every terminal. Wrapping the label keeps the status color
                visible regardless of `backgroundColor` support on <text>.
              */}
              <box backgroundColor={colorForCondition(c)} paddingLeft={1} paddingRight={1}>
                <text color="white">{c.type}</text>
              </box>
            </React.Fragment>
          ))}
        </box>
        {reasons.length > 0 && (
          <box flexDirection="column">
            {reasons.map((c) => (
              <text key={`reason-${c.type}`} opacity={0.5}>
                {c.type}: {conditionExplanation(c)}
              </text>
            ))}
          </box>
        )}
      </box>
    );
  },
);
