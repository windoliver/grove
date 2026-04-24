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

export function colorForStatus(status: ConditionStatus): string {
  if (status === "True") return theme.success;
  if (status === "False") return theme.error;
  return theme.warning;
}

export function shouldShowReason(c: Condition): boolean {
  return c.status !== "True" && c.reason.length > 0;
}

export const ConditionChips: React.NamedExoticComponent<ConditionChipsProps> = React.memo(
  function ConditionChips({ conditions }: ConditionChipsProps): React.ReactNode {
    if (conditions.length === 0) return null;
    const reasons = conditions.filter(shouldShowReason);
    return (
      <box flexDirection="column" marginBottom={1}>
        <box flexDirection="row">
          {conditions.map((c) => (
            <text key={c.type} color={colorForStatus(c.status)}>
              [{c.type}]{" "}
            </text>
          ))}
        </box>
        {reasons.length > 0 && (
          <box flexDirection="column">
            {reasons.map((c) => (
              <text key={`reason-${c.type}`} opacity={0.5}>
                {c.type}: {c.reason}
              </text>
            ))}
          </box>
        )}
      </box>
    );
  },
);
