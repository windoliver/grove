/**
 * Outcome badge component — displays outcome status as a colored tag.
 *
 * Used in DAG nodes, Detail view, and Claims/Activity panels.
 */

import React from "react";
import type { OutcomeStatus } from "../../core/outcome.js";
import { theme } from "../theme.js";

/** Props for the OutcomeBadge component. */
export interface OutcomeBadgeProps {
  readonly status: OutcomeStatus;
}

/** Color map for outcome statuses. */
const OUTCOME_COLORS: Record<OutcomeStatus, string> = {
  accepted: theme.success,
  rejected: theme.error,
  crashed: theme.warning,
  invalidated: theme.secondary,
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
