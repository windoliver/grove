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
import React, { useCallback, useMemo, useState } from "react";
import type { Page, PageKind, PagesStore } from "../data/pages-store.js";
import { useEntityStoreFactoryOptional } from "../hooks/entity-store-context.js";
import { useHints } from "../hooks/use-hints.js";
import { useScreenStack } from "../hooks/use-screen-stack.js";
import {
  type ConfirmAndMutateEntityBus,
  ConfirmAndMutateProvider,
  makeEntityBusFromStore,
} from "../safety/index.js";
import { BreadcrumbBar } from "./breadcrumb-bar.js";
import { ConfirmPopDialog } from "./confirm-pop-dialog.js";
import { HintBar } from "./hint-bar.js";

// Fallback bus used when no EntityStoreProvider is in scope (e.g., during
// early bootstrap before the informer factory is constructed, or in test
// trees that mount PagesRouter without the watch infrastructure). The
// banner stays off; the provider's CAS retry loop still works via the
// snapshot supplied by each trigger() call.
const NULL_BUS: ConfirmAndMutateEntityBus = {
  get: () => undefined,
  subscribe: () => () => undefined,
};

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
    const hints = useHints(store);
    const [dialogOpen, setDialogOpen] = useState(false);

    // ConfirmAndMutateProvider needs a live-entity feed to flip the
    // concurrent-mutation banner. Adapt the production EntityStoreFactory
    // when present, fall back to a no-op bus otherwise so PagesRouter
    // stays mountable in trees that haven't wired the watch infrastructure
    // (legacy tests; bootstrap before informer factory).
    const entityStoreFactory = useEntityStoreFactoryOptional();
    const entityBus = useMemo<ConfirmAndMutateEntityBus>(
      () => (entityStoreFactory ? makeEntityBusFromStore(entityStoreFactory) : NULL_BUS),
      [entityStoreFactory],
    );

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

    // Column layout with explicit row reservations so a page component
    // that renders `height="100%"` (RunningView, advanced/boardroom) can't
    // push the HintBar off-screen. Breadcrumb and HintBar are auto-height,
    // page content gets flexGrow=1 to fill the middle.
    //
    // ConfirmAndMutateProvider wraps the children so any screen below can
    // invoke `useConfirmAndMutate()` for dangerous mutations. The modal
    // (rendered by the provider itself) overlays at the same depth as the
    // dirty-pop dialog — both sit above the column layout.
    return (
      <ConfirmAndMutateProvider entityBus={entityBus}>
        <box flexDirection="column" width="100%" height="100%">
          <box flexShrink={0}>
            <BreadcrumbBar
              stack={snapshot}
              presetName={presetName}
              sessionId={sessionId}
              width={width}
            />
          </box>
          <box flexGrow={1} flexShrink={1}>
            {React.createElement(Component, { page: top })}
          </box>
          <box flexShrink={0}>
            <HintBar hints={hints} width={width} />
          </box>
          <ConfirmPopDialog
            visible={dialogOpen}
            onConfirm={handleConfirm}
            onCancel={handleCancel}
          />
        </box>
      </ConfirmAndMutateProvider>
    );
  },
);
