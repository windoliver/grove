/**
 * DagStateStore — pure data class for xray-style DAG view UI state (#311).
 *
 * Owns:
 *   - collapsed: Set of cids whose subtree is collapsed in the view.
 *   - focusCid : optional root cid for focused projections.
 *   - highlight: current /foo highlight string (model-layer, not a filter).
 *
 * Lives above the DAG view in the component tree (constructed in
 * screen-manager) so state survives view unmount/remount when the user
 * navigates between panels.
 *
 * Mirrors the PagesStore pattern: subscribe by event, mutators emit
 * synchronously, snapshot() returns the same object reference until a
 * mutation occurs (required by useSyncExternalStore). Listener errors are
 * isolated via try/catch so one throwing listener cannot starve the rest
 * or propagate out of a mutator.
 */

import { debugLog } from "../debug-log.js";

export interface DagStateSnapshot {
  readonly collapsed: ReadonlySet<string>;
  readonly focusCid: string | null;
  readonly highlight: string;
}

export type DagStateEvent = "change";
export type DagStateListener = () => void;

/**
 * Returns a Set view whose mutators throw — `Object.freeze(new Set())` only
 * freezes own properties, not the internal slot used by `Set.prototype.add`,
 * so we replace the mutators explicitly.
 */
function freezeSet(set: Set<string>): ReadonlySet<string> {
  const throwReadOnly = (): never => {
    throw new TypeError("DagStateSnapshot.collapsed is read-only");
  };
  Object.defineProperty(set, "add", { value: throwReadOnly });
  Object.defineProperty(set, "delete", { value: throwReadOnly });
  Object.defineProperty(set, "clear", { value: throwReadOnly });
  Object.freeze(set);
  return set;
}

export class DagStateStore {
  private collapsed: Set<string> = new Set();
  private focusCid: string | null = null;
  private highlight = "";
  private listeners: Set<DagStateListener> = new Set();
  private cachedSnapshot: DagStateSnapshot | null = null;

  toggleCollapsed(cid: string): void {
    if (this.collapsed.has(cid)) {
      this.collapsed.delete(cid);
    } else {
      this.collapsed.add(cid);
    }
    this.invalidate();
  }

  setFocus(cid: string | null): void {
    if (this.focusCid === cid) return;
    this.focusCid = cid;
    this.invalidate();
  }

  setHighlight(text: string): void {
    if (this.highlight === text) return;
    this.highlight = text;
    this.invalidate();
  }

  expandAll(): void {
    if (this.collapsed.size === 0) return;
    this.collapsed.clear();
    this.invalidate();
  }

  collapseAll(cids: Iterable<string>): void {
    let changed = false;
    for (const cid of cids) {
      if (!this.collapsed.has(cid)) {
        this.collapsed.add(cid);
        changed = true;
      }
    }
    if (changed) this.invalidate();
  }

  snapshot(): DagStateSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    const snap: DagStateSnapshot = {
      collapsed: freezeSet(new Set(this.collapsed)),
      focusCid: this.focusCid,
      highlight: this.highlight,
    };
    this.cachedSnapshot = snap;
    return snap;
  }

  subscribe(_event: DagStateEvent, listener: DagStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private invalidate(): void {
    this.cachedSnapshot = null;
    // Snapshot listeners before iterating so self-unsubscribe during emit
    // is safe, and wrap each call so a throwing listener cannot starve the
    // rest or propagate out of a mutator.
    const snapshot = [...this.listeners];
    for (const l of snapshot) {
      try {
        l();
      } catch (err) {
        debugLog(
          "DagStateStore",
          `listener threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
