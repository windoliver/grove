/**
 * Outcome badge component — displays outcome status as a colored tag.
 *
 * Used in DAG nodes, Detail view, and Claims/Activity panels.
 */

import React from "react";
import type { OutcomeStatus } from "../../core/outcome.js";

/** Props for the OutcomeBadge component. */
export interface OutcomeBadgeProps {
  readonly status: OutcomeStatus;
}

/** Color map for outcome statuses. */
const OUTCOME_COLORS: Record<OutcomeStatus, string> = {
  accepted: "#00cc00",
  rejected: "#cc0000",
  crashed: "#cccc00",
  invalidated: "#888888",
};

/** Short labels for outcome statuses. */
const OUTCOME_LABELS: Record<OutcomeStatus, string> = {
  accepted: "ACC",
  rejected: "REJ",
  crashed: "CRA",
  invalidated: "INV",
};

/** Compact outcome badge: [ACC], [REJ], [CRA], [INV]. */
export const OutcomeBadge: React.NamedExoticComponent<OutcomeBadgeProps> = React.memo(
  function OutcomeBadge({ status }: OutcomeBadgeProps): React.ReactNode {
    return <text color={OUTCOME_COLORS[status]}>[{OUTCOME_LABELS[status]}]</text>;
  },
);
