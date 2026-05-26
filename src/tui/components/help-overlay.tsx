/**
 * Help overlay for the TUI — triggered by `?` key.
 *
 * Shows context-sensitive keybinding reference.
 * Follows the k9s/lazygit convention of `?` for help.
 */

import React from "react";
import type { Panel } from "../hooks/use-panel-focus.js";
import { formatKeySequence, type KeyBinding, type ResolvedKeymap } from "../keymap/keymap.js";
import { theme } from "../theme.js";

/** Props for the HelpOverlay component. */
export interface HelpOverlayProps {
  readonly visible: boolean;
  /** Whether the user is in a detail view (affects which bindings are shown). */
  readonly isDetailView?: boolean | undefined;
  /** Which panel is focused (for panel-specific hints). */
  readonly focusedPanel?: Panel | undefined;
  /** Resolved active keymap, including preset defaults and user overrides. */
  readonly resolvedKeymap: ResolvedKeymap;
}

/** A keybinding entry for display. */
interface KeyBindingEntry {
  readonly key: string;
  readonly description: string;
}

const DETAIL_BINDINGS: readonly KeyBindingEntry[] = [
  { key: "Esc", description: "Back to list" },
  { key: "j / k", description: "Scroll content" },
];

function bindingsForContext(
  keymap: ResolvedKeymap,
  context: KeyBinding["context"],
): readonly KeyBinding[] {
  return keymap.bindings.filter((binding) => binding.context === context && binding.preferred);
}

function bindingsForPanel(keymap: ResolvedKeymap, panel: Panel | undefined): readonly KeyBinding[] {
  if (panel === undefined) return [];
  return keymap.bindings.filter(
    (binding) => binding.context === "panel" && binding.panel === panel && binding.preferred,
  );
}

function toDisplayBinding(binding: KeyBinding): KeyBindingEntry {
  return { key: formatKeySequence(binding.sequence), description: binding.label };
}

function renderSection(title: string, bindings: readonly KeyBindingEntry[]): React.ReactNode {
  return (
    <box flexDirection="column" key={title}>
      <box>
        <text bold color={theme.focus}>
          {title}
        </text>
      </box>
      {bindings.map((b) => (
        <box key={b.key} paddingLeft={1} flexDirection="row">
          <text color={theme.text} bold>
            {b.key.padEnd(14)}
          </text>
          <text color={theme.secondary}>{b.description}</text>
        </box>
      ))}
    </box>
  );
}

/** Help overlay showing keybinding reference. */
export const HelpOverlay: React.NamedExoticComponent<HelpOverlayProps> = React.memo(
  function HelpOverlay({
    visible,
    isDetailView,
    focusedPanel,
    resolvedKeymap,
  }: HelpOverlayProps): React.ReactNode {
    if (!visible) return null;

    const sections: React.ReactNode[] = [];

    sections.push(
      renderSection("Global", bindingsForContext(resolvedKeymap, "global").map(toDisplayBinding)),
    );

    if (isDetailView) {
      sections.push(renderSection("Detail View", DETAIL_BINDINGS));
    } else {
      sections.push(
        renderSection(
          "Navigation",
          bindingsForContext(resolvedKeymap, "navigation").map(toDisplayBinding),
        ),
      );
      sections.push(
        renderSection("Panels", bindingsForContext(resolvedKeymap, "panel").map(toDisplayBinding)),
      );
    }

    const focusedBindings = bindingsForPanel(resolvedKeymap, focusedPanel).map(toDisplayBinding);
    if (focusedBindings.length > 0) sections.push(renderSection("Focused Panel", focusedBindings));

    sections.push(
      renderSection(
        "Messaging",
        bindingsForContext(resolvedKeymap, "messaging").map(toDisplayBinding),
      ),
    );

    return (
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <box>
          <text bold color={theme.focus}>
            Keybinding Reference (? to close)
          </text>
        </box>
        <box marginTop={1} flexDirection="column">
          {sections}
        </box>
      </box>
    );
  },
);
