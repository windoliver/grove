/**
 * Agent creation wizard — multi-step inline wizard for spawning agents (item 15).
 *
 * Steps:
 * 1. Select agent profile (from agents.json) or role (from topology)
 * 2. Pick target ref/branch
 * 3. Confirm and spawn
 *
 * Reuses the welcome screen's j/k + Enter navigation pattern.
 */

import React from "react";
import type { AgentTopology } from "../../core/topology.js";
import { theme } from "../theme.js";

/** Wizard step identifier. */
export type WizardStep = "profile" | "target" | "confirm";

/** Wizard state managed by the parent. */
export interface WizardState {
  readonly step: WizardStep;
  readonly selectedProfile: number;
  readonly targetRef: string;
  readonly profiles: readonly { name: string; role: string; platform: string }[];
}

/** Initial wizard state. */
export function initialWizardState(
  profiles: readonly { name: string; role: string; platform: string }[],
  topology?: AgentTopology,
): WizardState {
  // Merge profiles with topology roles that don't have profiles
  const allProfiles = [...profiles];
  if (topology) {
    const profileRoles = new Set(profiles.map((p) => p.role));
    for (const role of topology.roles) {
      if (!profileRoles.has(role.name)) {
        allProfiles.push({ name: `@${role.name}`, role: role.name, platform: "custom" });
      }
    }
  }

  return {
    step: "profile",
    selectedProfile: 0,
    targetRef: "HEAD",
    profiles: allProfiles,
  };
}

/** Props for the AgentWizard component. */
export interface AgentWizardProps {
  readonly visible: boolean;
  readonly state: WizardState;
  readonly cursorIndex: number;
}

/** Agent creation wizard overlay. */
export const AgentWizard: React.NamedExoticComponent<AgentWizardProps> = React.memo(
  function AgentWizard({ visible, state, cursorIndex }: AgentWizardProps): React.ReactNode {
    if (!visible) return null;

    const stepLabels: Record<WizardStep, string> = {
      profile: "Step 1/3: Select Agent Profile",
      target: "Step 2/3: Choose Target",
      confirm: "Step 3/3: Confirm & Spawn",
    };

    return (
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <box>
          <text color={theme.focus} bold>
            Agent Wizard — {stepLabels[state.step]}
          </text>
        </box>

        {state.step === "profile" && (
          <box flexDirection="column" paddingLeft={1} marginTop={1}>
            {state.profiles.length === 0 ? (
              <text color={theme.muted}>No profiles available. Register agents first.</text>
            ) : (
              state.profiles.map((p, i) => {
                const isSelected = cursorIndex === i;
                return (
                  <box key={p.name}>
                    <text color={isSelected ? theme.focus : theme.text}>
                      {isSelected ? "> " : "  "}
                      {p.name}
                    </text>
                    <text color={theme.muted}>
                      {" "}
                      [{p.platform}] role: {p.role}
                    </text>
                  </box>
                );
              })
            )}
          </box>
        )}

        {state.step === "target" && (
          <box flexDirection="column" paddingLeft={1} marginTop={1}>
            {["HEAD", "main", "dev"].map((ref, i) => {
              const isSelected = cursorIndex === i;
              return (
                <box key={ref}>
                  <text color={isSelected ? theme.focus : theme.text}>
                    {isSelected ? "> " : "  "}
                    {ref}
                  </text>
                </box>
              );
            })}
          </box>
        )}

        {state.step === "confirm" && (
          <box flexDirection="column" paddingLeft={1} marginTop={1}>
            <text color={theme.text}>
              Profile: {state.profiles[state.selectedProfile]?.name ?? "?"}
            </text>
            <text color={theme.text}>
              Role: {state.profiles[state.selectedProfile]?.role ?? "?"}
            </text>
            <text color={theme.text}>Target: {state.targetRef}</text>
            <text color={theme.muted} />
            <box>
              <text color={cursorIndex === 0 ? theme.focus : theme.text}>
                {cursorIndex === 0 ? "> " : "  "}
                Spawn
              </text>
              <text color={theme.muted}> </text>
              <text color={cursorIndex === 1 ? theme.focus : theme.text}>
                {cursorIndex === 1 ? "> " : "  "}
                Cancel
              </text>
            </box>
          </box>
        )}

        <box marginTop={1} paddingLeft={1}>
          <text color={theme.muted}>[j/k] navigate [Enter] select [Esc] cancel</text>
        </box>
      </box>
    );
  },
);
