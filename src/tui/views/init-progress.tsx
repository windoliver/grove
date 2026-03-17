/**
 * Init progress view — shows step-by-step progress during grove initialization.
 *
 * Displayed after the user selects a preset from the welcome screen,
 * while executeInit runs in the background.
 */

import React from "react";
import { theme } from "../theme.js";

/** A single initialization step. */
export interface InitStep {
  readonly label: string;
  readonly done: boolean;
}

/** Props for the InitProgressView component. */
export interface InitProgressProps {
  readonly presetName: string;
  readonly steps: readonly InitStep[];
  readonly error?: string | undefined;
}

/** Initialization progress display with step checkmarks. */
export const InitProgressView: React.NamedExoticComponent<InitProgressProps> = React.memo(
  function InitProgressView({ presetName, steps, error }: InitProgressProps): React.ReactNode {
    return (
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        borderStyle="round"
        borderColor={error ? theme.error : theme.focus}
        paddingX={2}
        paddingTop={1}
      >
        <text color={theme.focus} bold>
          Setting up {presetName}...
        </text>
        <text color={theme.muted}>{""}</text>

        {steps.map((step, i) => {
          const icon = step.done ? theme.agentRunning : theme.agentWaiting;
          const iconColor = step.done ? theme.success : theme.waiting;
          // Current step is the first non-done step
          const isCurrent = !step.done && (i === 0 || (steps[i - 1]?.done ?? false));

          return (
            <box key={step.label} flexDirection="row">
              <text color={isCurrent ? theme.text : step.done ? theme.success : theme.muted}>
                {"  "}
              </text>
              <text color={iconColor}>{icon}</text>
              <text color={isCurrent ? theme.text : step.done ? theme.success : theme.muted}>
                {`  ${step.label}`}
              </text>
            </box>
          );
        })}

        {error ? (
          <box flexDirection="column" marginTop={1}>
            <text color={theme.error} bold>
              Error: {error}
            </text>
            <text color={theme.muted}>Esc:back to setup q:quit</text>
          </box>
        ) : null}
      </box>
    );
  },
);
