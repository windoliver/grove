/**
 * PagesRouter — integration point that maps the top page to a screen component
 * and renders the breadcrumb. Handles the dirty-confirm dialog when open.
 *
 * Architecture:
 *   - Pure key-reducer (reduceRouterKey) is exported so tests can exercise it
 *     directly without mounting any components or mocking useKeyboard.
 *   - The component composes the reducer with useKeyboard and applies actions.
 *
 * Esc handling note:
 *   In production, multiple components register `useKeyboard` handlers via
 *   `@opentui/react` and ALL handlers fire on every keypress (no
 *   stopPropagation). To avoid double-pop / unwanted-quit conflicts with
 *   inner screens that already handle escape (running-view, agent-detect,
 *   goal-input, etc.), this router does NOT pop or quit on bare escape.
 *   Pop/quit responsibility lives entirely with inner screens, whose onBack
 *   callbacks are wired by screen-manager to pages.pop/replace/resetTo.
 *   The router only consumes keys when the confirm dialog is open.
 *
 * Dormant dirty-confirm UX:
 *   `<ConfirmPopDialog>` and `setDialogOpen` are wired but never triggered in
 *   production. `pages.hasDirtyTop()` and the goal-input/prompt-mode dirty
 *   checks are registered (Task 9 / #303) but no caller fires the dialog yet.
 *   A follow-up will rewire dirty → confirm UX through a different mechanism
 *   that respects the multi-handler keyboard model documented above.
 */

import { useKeyboard } from "@opentui/react";
import React, { useCallback, useState } from "react";
import type { Page, PageKind, PagesStore } from "../data/pages-store.js";
import { useScreenStack } from "../hooks/use-screen-stack.js";
import { BreadcrumbBar } from "./breadcrumb-bar.js";
import { ConfirmPopDialog } from "./confirm-pop-dialog.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PagesRouterComponentMap = Record<PageKind, React.ComponentType<{ page: Page }>>;

export interface PagesRouterProps {
  readonly store: PagesStore;
  readonly components: PagesRouterComponentMap;
  readonly width: number;
  readonly presetName?: string | undefined;
  readonly sessionId?: string | undefined;
}

// ---------------------------------------------------------------------------
// Pure key reducer (exported for tests)
// ---------------------------------------------------------------------------

export type RouterAction =
  | { type: "noop" }
  | { type: "closeDialog" }
  | { type: "popAndCloseDialog" };

export interface RouterKeyState {
  readonly dialogOpen: boolean;
}

export function reduceRouterKey(state: RouterKeyState, keyName: string): RouterAction {
  if (!state.dialogOpen) return { type: "noop" };
  if (keyName === "y") return { type: "popAndCloseDialog" };
  if (keyName === "n" || keyName === "escape") return { type: "closeDialog" };
  return { type: "noop" };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PagesRouter: React.NamedExoticComponent<PagesRouterProps> = React.memo(
  function PagesRouter({ store, components, width, presetName, sessionId }: PagesRouterProps) {
    const { top, snapshot } = useScreenStack(store);
    const [dialogOpen, setDialogOpen] = useState(false);

    const handleConfirm = useCallback(() => {
      store.pop();
      setDialogOpen(false);
    }, [store]);

    const handleCancel = useCallback(() => {
      setDialogOpen(false);
    }, []);

    useKeyboard(
      useCallback(
        (key) => {
          // Fast-path: when the dialog is closed, this handler is a noop.
          // Pop/quit lives in inner screens to avoid useKeyboard handler
          // conflicts (see file header).
          if (!dialogOpen) return;
          const action = reduceRouterKey({ dialogOpen }, key.name);
          switch (action.type) {
            case "closeDialog":
              setDialogOpen(false);
              break;
            case "popAndCloseDialog":
              store.pop();
              setDialogOpen(false);
              break;
            case "noop":
              break;
          }
        },
        [dialogOpen, store],
      ),
    );

    if (top === undefined) return null;

    const Component = components[top.kind];

    return (
      <>
        <BreadcrumbBar
          stack={snapshot}
          presetName={presetName}
          sessionId={sessionId}
          width={width}
        />
        <Component page={top} />
        <ConfirmPopDialog visible={dialogOpen} onConfirm={handleConfirm} onCancel={handleCancel} />
      </>
    );
  },
);
