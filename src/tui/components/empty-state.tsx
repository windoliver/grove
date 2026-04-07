/**
 * Reusable empty-state component for panels with no data.
 *
 * Provides consistent actionable guidance instead of generic "(no data)"
 * placeholders. Every panel should use this for its zero-data case.
 */

import React from "react";
import { theme } from "../theme.js";

/** Props for the EmptyState component. */
export interface EmptyStateProps {
  /** Primary message describing the empty state. */
  readonly title: string;
  /** Actionable hint telling the user what to do next. */
  readonly hint?: string | undefined;
}

/** Empty state with title and optional actionable hint. */
export const EmptyState: React.NamedExoticComponent<EmptyStateProps> = React.memo(
  function EmptyState({ title, hint }: EmptyStateProps): React.ReactNode {
    return (
      <box flexDirection="column" paddingTop={1}>
        <text color={theme.secondary}>{title}</text>
        {hint && (
          <text color={theme.secondary} opacity={0.7}>
            {hint}
          </text>
        )}
      </box>
    );
  },
);
