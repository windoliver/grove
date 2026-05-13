/**
 * PagesStore — k9s-style navigation stack for the TUI.
 *
 * Pure data class (no React). Maintains an ordered stack of Pages with
 * push/pop/replace/resetTo semantics, event subscriptions, and dirty-check
 * registration.
 */

import { debugLog } from "../debug-log.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PageKind =
  | "preset-select"
  | "goal-input"
  | "agent-detect"
  | "launch-preview"
  | "spawning"
  | "running"
  | "complete"
  | "advanced"
  | "panel"
  | "entity-detail";

export interface Page {
  readonly kind: PageKind;
  readonly params?: Readonly<Record<string, string>>;
}

export type StackEvent =
  | { type: "pushed"; page: Page; depth: number }
  | { type: "popped"; page: Page; depth: number }
  | { type: "top"; page: Page; depth: number };

export type DirtyCheck = () => boolean;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type EventType = StackEvent["type"];
type Listener = (e: StackEvent) => void;

/**
 * Deep-equality check for two Page values.
 * Pages are equal when kind matches AND params are key-by-key identical.
 */
function pagesEqual(a: Page, b: Page): boolean {
  if (a.kind !== b.kind) return false;
  const ap = a.params;
  const bp = b.params;
  if (ap === undefined && bp === undefined) return true;
  if (ap === undefined || bp === undefined) return false;
  const aKeys = Object.keys(ap);
  const bKeys = Object.keys(bp);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (ap[key] !== bp[key]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// PagesStore
// ---------------------------------------------------------------------------

export class PagesStore {
  private readonly stack: Page[] = [];
  private cachedSnapshot: readonly Page[] | null = null;

  private readonly subs: Record<EventType, Set<Listener>> = {
    pushed: new Set(),
    popped: new Set(),
    top: new Set(),
  };

  private readonly dirtyChecks: Map<PageKind, Set<DirtyCheck>> = new Map();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  push(page: Page): void {
    const current = this.top();
    if (current !== undefined && pagesEqual(current, page)) return;
    this.stack.push(page);
    this.invalidateSnapshot();
    const depth = this.stack.length;
    this.emit({ type: "pushed", page, depth });
    this.emit({ type: "top", page, depth });
  }

  pop(): Page | undefined {
    if (this.stack.length <= 1) return undefined;
    const page = this.stack.pop();
    if (page === undefined) return undefined;
    this.invalidateSnapshot();
    const depth = this.stack.length;
    this.emit({ type: "popped", page, depth });
    const newTop = this.stack[depth - 1];
    if (newTop !== undefined) {
      this.emit({ type: "top", page: newTop, depth });
    }
    return page;
  }

  replace(page: Page): void {
    const current = this.top();
    if (current !== undefined && pagesEqual(current, page)) return;
    if (this.stack.length === 0) {
      // Act like push on empty stack
      this.stack.push(page);
      this.invalidateSnapshot();
      const depth = this.stack.length;
      this.emit({ type: "pushed", page, depth });
      this.emit({ type: "top", page, depth });
      return;
    }
    this.stack[this.stack.length - 1] = page;
    this.invalidateSnapshot();
    const depth = this.stack.length;
    this.emit({ type: "pushed", page, depth });
    this.emit({ type: "top", page, depth });
  }

  resetTo(page: Page): void {
    // Fire popped for each entry from top to bottom
    while (this.stack.length > 0) {
      const removed = this.stack.pop();
      if (removed === undefined) break;
      this.invalidateSnapshot();
      this.emit({ type: "popped", page: removed, depth: this.stack.length });
    }
    // Push the new page
    this.stack.push(page);
    this.invalidateSnapshot();
    const depth = this.stack.length;
    this.emit({ type: "pushed", page, depth });
    this.emit({ type: "top", page, depth });
  }

  top(): Page | undefined {
    return this.stack[this.stack.length - 1];
  }

  depth(): number {
    return this.stack.length;
  }

  snapshot(): readonly Page[] {
    if (this.cachedSnapshot === null) {
      this.cachedSnapshot = Object.freeze([...this.stack]);
    }
    return this.cachedSnapshot;
  }

  subscribe(type: EventType, fn: Listener): () => void {
    this.subs[type].add(fn);
    return () => {
      this.subs[type].delete(fn);
    };
  }

  registerDirtyCheck(kind: PageKind, fn: DirtyCheck): () => void {
    if (!this.dirtyChecks.has(kind)) {
      this.dirtyChecks.set(kind, new Set());
    }
    this.dirtyChecks.get(kind)?.add(fn);
    return () => {
      this.dirtyChecks.get(kind)?.delete(fn);
    };
  }

  hasDirtyTop(): boolean {
    const current = this.top();
    if (current === undefined) return false;
    const checks = this.dirtyChecks.get(current.kind);
    if (checks === undefined || checks.size === 0) return false;
    for (const check of checks) {
      try {
        if (check()) return true;
      } catch {
        debugLog("PagesStore", `dirty-check for kind=${current.kind} threw; treating as dirty`);
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private invalidateSnapshot(): void {
    this.cachedSnapshot = null;
  }

  private emit(event: StackEvent): void {
    const listeners = this.subs[event.type];
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (err) {
        debugLog(
          "PagesStore",
          `listener for event=${event.type} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
