/**
 * PagesRouter — integration point that maps the top page to a screen component,
 * handles esc-pop with confirm-on-dirty, and renders the breadcrumb.
 *
 * Architecture:
 *   - Pure key-reducer (reduceRouterKey) is exported so tests can exercise it
 *     directly without mounting any components or mocking useKeyboard.
 *   - The component composes the reducer with useKeyboard and applies actions.
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
  readonly onQuit: () => void;
  readonly width: number;
}

// ---------------------------------------------------------------------------
// Pure key reducer (exported for tests)
// ---------------------------------------------------------------------------

export type RouterAction =
  | { type: "noop" }
  | { type: "pop" }
  | { type: "openDialog" }
  | { type: "closeDialog" }
  | { type: "popAndCloseDialog" }
  | { type: "quit" };

export interface RouterKeyState {
  readonly dialogOpen: boolean;
  readonly dirty: boolean; // hasDirtyTop()
  readonly depth: number;
}

export function reduceRouterKey(state: RouterKeyState, keyName: string): RouterAction {
  if (state.dialogOpen) {
    if (keyName === "y") return { type: "popAndCloseDialog" };
    if (keyName === "n" || keyName === "escape") return { type: "closeDialog" };
    return { type: "noop" };
  }
  if (keyName !== "escape") return { type: "noop" };
  if (state.dirty) return { type: "openDialog" };
  if (state.depth <= 1) return { type: "quit" };
  return { type: "pop" };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PagesRouter: React.NamedExoticComponent<PagesRouterProps> = React.memo(
  function PagesRouter({ store, components, onQuit, width }: PagesRouterProps) {
    const { top, depth, snapshot } = useScreenStack(store);
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
          const state: RouterKeyState = {
            dialogOpen,
            dirty: store.hasDirtyTop(),
            depth,
          };
          const action = reduceRouterKey(state, key.name);
          switch (action.type) {
            case "pop":
              store.pop();
              break;
            case "openDialog":
              setDialogOpen(true);
              break;
            case "closeDialog":
              setDialogOpen(false);
              break;
            case "popAndCloseDialog":
              store.pop();
              setDialogOpen(false);
              break;
            case "quit":
              onQuit();
              break;
            case "noop":
              break;
          }
        },
        [dialogOpen, store, depth, onQuit],
      ),
    );

    if (top === undefined) return null;

    const Component = components[top.kind];

    return (
      <>
        <BreadcrumbBar stack={snapshot} width={width} />
        <Component page={top} />
        <ConfirmPopDialog visible={dialogOpen} onConfirm={handleConfirm} onCancel={handleCancel} />
      </>
    );
  },
);
