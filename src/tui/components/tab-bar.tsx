/**
 * Panel indicator bar for showing focused panel in multi-panel layout.
 */

import React from "react";
import type { PanelFocusState } from "../hooks/use-panel-focus.js";
import { getVisiblePanels, PANEL_LABELS } from "../hooks/use-panel-focus.js";
import { theme } from "../theme.js";

/** Props for the PanelBar component. */
export interface PanelBarProps {
  readonly panelState: PanelFocusState;
}

/** Horizontal panel indicator bar with numbered labels. */
export const PanelBar: React.NamedExoticComponent<PanelBarProps> = React.memo(function PanelBar({
  panelState,
}: PanelBarProps): React.ReactNode {
  const visible = getVisiblePanels(panelState);

  return (
    <box>
      {visible.map((panel) => {
        const isActive = panel === panelState.focused;
        return (
          <box key={panel} marginRight={2}>
            <text bold={isActive} color={isActive ? theme.focus : theme.muted}>
              {isActive ? `[${panel}:${PANEL_LABELS[panel]}]` : ` ${panel}:${PANEL_LABELS[panel]} `}
            </text>
          </box>
        );
      })}
    </box>
  );
});
