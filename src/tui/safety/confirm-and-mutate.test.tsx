/**
 * Unit tests for the ConfirmAndMutateProvider + useConfirmAndMutate hook (C6 #304).
 *
 * Covers the five scenarios from the C6 design spec §6:
 *   1. Happy path — confirm → mutation receives token with snapshot RV → ok
 *   2. Cancel — { ok: false, reason: "cancelled" }; mutation never called
 *   3. 409 once → retry with fresh snapshot succeeds
 *   4. 409 four times in a row → { ok: false, reason: "max-retries" }
 *   5. External RV change while modal open → banner appears
 *
 * The provider is decoupled from the production EntityStore via the
 * `ConfirmAndMutateEntityBus` interface — the tests pass a small in-memory
 * fake, production code wraps an `EntityStoreFactory` (T11).
 */

import { describe, expect, mock, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { EntityForKind } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mock @opentui/react so we can drive keyboard input from the test
// ---------------------------------------------------------------------------

type KeyboardKey = { readonly name?: string | undefined };
type KeyboardHandler = (key: KeyboardKey) => void;

const registeredHandlers: KeyboardHandler[] = [];

mock.module("@opentui/react", () => ({
  useKeyboard: (handler: KeyboardHandler): void => {
    // The test renderer calls useKeyboard on every render; we keep the latest
    // handler on top so dispatchKey targets the freshest closure.
    registeredHandlers.push(handler);
  },
  useRenderer: (): { destroy: () => void } => ({ destroy: () => undefined }),
  useTerminalDimensions: (): { width: number; height: number } => ({ width: 120, height: 40 }),
  useTimeline: (): { add: () => unknown; play: () => unknown } => ({
    add: () => ({ add: () => ({ play: () => undefined }), play: () => undefined }),
    play: () => undefined,
  }),
}));

// Import AFTER mock.module so the provider picks up the mocked useKeyboard.
const { ConfirmAndMutateProvider, useConfirmAndMutate } = (await import(
  "./confirm-and-mutate.js"
)) as typeof import("./confirm-and-mutate.js");

// Local structural alias for the request shape. We could import the real
// `ConfirmAndMutateRequest<K, R>` type but it accepts a `DangerousToken`
// in the mutation arg, and we want the tests to verify only the visible
// surface of the token (`ifMatch`, `id`) without depending on the brand.
interface ConfirmAndMutateRequestShape<K extends WatchKind, R> {
  readonly entity: EntityForKind<K>;
  readonly message: string;
  readonly dangerous: true;
  readonly mutation: (token: { readonly ifMatch: string; readonly id: string }) => Promise<R>;
}

type ConfirmAndMutateResult<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly reason: "cancelled" | "max-retries" };

// ---------------------------------------------------------------------------
// FakeEntityBus — implements the provider's ConfirmAndMutateEntityBus contract
// ---------------------------------------------------------------------------

type Key = string;
function busKey(kind: string, id: string): Key {
  return `${kind}:${id}`;
}

class FakeEntityBus {
  private readonly state = new Map<Key, EntityForKind<WatchKind>>();
  private readonly listeners = new Map<
    Key,
    Set<(e: EntityForKind<WatchKind> | undefined) => void>
  >();

  set<K extends WatchKind>(kind: K, id: string, entity: EntityForKind<K>): void {
    const k = busKey(kind, id);
    this.state.set(k, entity);
    const subs = this.listeners.get(k);
    if (subs) {
      for (const fn of subs) fn(entity);
    }
  }

  get<K extends WatchKind>(kind: K, id: string): EntityForKind<K> | undefined {
    return this.state.get(busKey(kind, id)) as EntityForKind<K> | undefined;
  }

  subscribe<K extends WatchKind>(
    kind: K,
    id: string,
    cb: (e: EntityForKind<K> | undefined) => void,
  ): () => void {
    const k = busKey(kind, id);
    let set = this.listeners.get(k);
    if (!set) {
      set = new Set();
      this.listeners.set(k, set);
    }
    const wrapped = cb as (e: EntityForKind<WatchKind> | undefined) => void;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }
}

// ---------------------------------------------------------------------------
// Test entity + harness
// ---------------------------------------------------------------------------

const FAKE_ENTITY: EntityForKind<"AgentSession"> = {
  kind: "AgentSession",
  namespace: "ns",
  id: "sess-1",
  resourceVersion: "5",
  spec: { role: "reviewer" },
  status: { phase: "idle" },
  conditions: [],
  observedGeneration: 0,
  metadata: { generation: 1 },
};

type TriggerFn = <R>(
  req: ConfirmAndMutateRequestShape<"AgentSession", R>,
) => Promise<ConfirmAndMutateResult<R>>;

function dispatchKey(name: string): void {
  // Fire to the latest registered handler. The provider re-registers on
  // every render, so the most recent handler closes over the freshest state.
  const latest = registeredHandlers[registeredHandlers.length - 1];
  if (latest) latest({ name });
}

async function renderHarness<R>(
  mutation: (token: { readonly ifMatch: string; readonly id: string }) => Promise<R>,
): Promise<{
  readonly bus: FakeEntityBus;
  readonly tree: TestRenderer.ReactTestRenderer;
  readonly invoke: () => Promise<ConfirmAndMutateResult<R>>;
}> {
  const bus = new FakeEntityBus();
  bus.set("AgentSession", "sess-1", FAKE_ENTITY);
  let triggerRef: TriggerFn | null = null;

  function Caller(): React.ReactNode {
    triggerRef = useConfirmAndMutate() as TriggerFn;
    return null;
  }

  // The provider must accept an `entityBus` prop so tests can inject the
  // fake without spinning up the full EntityStore infra.
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      (
        <ConfirmAndMutateProvider entityBus={bus}>
          <Caller />
        </ConfirmAndMutateProvider>
      ) as React.ReactElement,
    );
  });

  return {
    bus,
    tree,
    invoke: () => {
      if (!triggerRef) throw new Error("useConfirmAndMutate did not return a trigger");
      return triggerRef({
        entity: FAKE_ENTITY,
        message: "Delete session?",
        dangerous: true,
        mutation: mutation as (token: {
          readonly ifMatch: string;
          readonly id: string;
        }) => Promise<R>,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("useConfirmAndMutate", () => {
  test("happy path: confirm → mutation receives token with snapshot RV → ok", async () => {
    const mutation = mock(
      async (_token: { readonly ifMatch: string; readonly id: string }) => "result",
    );
    const harness = await renderHarness(mutation);
    let result: ConfirmAndMutateResult<string> | undefined;

    await act(async () => {
      const p = harness.invoke();
      // Yield once so the provider's setState commits the modal-open state
      // and re-registers the keyboard handler.
      await Promise.resolve();
      dispatchKey("y");
      result = await p;
    });

    expect(result).toEqual({ ok: true, value: "result" });
    expect(mutation).toHaveBeenCalledTimes(1);
    const firstCallArg = mutation.mock.calls[0]?.[0];
    expect(firstCallArg?.ifMatch).toBe("5");
    expect(firstCallArg?.id).toBe("sess-1");
  });

  test("cancel returns { ok: false, reason: 'cancelled' } and skips mutation", async () => {
    const mutation = mock(async (_token: { readonly ifMatch: string; readonly id: string }) => "x");
    const harness = await renderHarness(mutation);
    let result: ConfirmAndMutateResult<string> | undefined;

    await act(async () => {
      const p = harness.invoke();
      await Promise.resolve();
      dispatchKey("n");
      result = await p;
    });

    expect(result).toEqual({ ok: false, reason: "cancelled" });
    expect(mutation).not.toHaveBeenCalled();
  });

  test("409 once → retry with fresh snapshot succeeds", async () => {
    let attempts = 0;
    const mutation = mock(async (_token: { readonly ifMatch: string; readonly id: string }) => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("conflict") as Error & {
          status?: number;
          current?: { readonly resourceVersion: string; readonly generation: number };
        };
        err.status = 409;
        err.current = { resourceVersion: "6", generation: 2 };
        throw err;
      }
      return "result";
    });
    const harness = await renderHarness(mutation);
    let result: ConfirmAndMutateResult<string> | undefined;

    await act(async () => {
      const p = harness.invoke();
      await Promise.resolve();
      dispatchKey("y"); // first submit → 409
      // Give the rejected mutation a chance to settle and re-render
      await Promise.resolve();
      await Promise.resolve();
      dispatchKey("y"); // retry → ok
      result = await p;
    });

    expect(result).toEqual({ ok: true, value: "result" });
    expect(mutation.mock.calls).toHaveLength(2);
    const secondCallArg = mutation.mock.calls[1]?.[0];
    expect(secondCallArg?.ifMatch).toBe("6");
  });

  test("409 four times in a row → { ok: false, reason: 'max-retries' }", async () => {
    const mutation = mock(async () => {
      const err = new Error("conflict") as Error & {
        status?: number;
        current?: { readonly resourceVersion: string; readonly generation: number };
      };
      err.status = 409;
      err.current = { resourceVersion: "9", generation: 4 };
      throw err;
    });
    const harness = await renderHarness(mutation);
    let result: ConfirmAndMutateResult<string> | undefined;

    await act(async () => {
      const p = harness.invoke();
      await Promise.resolve();
      // 4 attempts at submit (initial + 3 retries)
      for (let i = 0; i < 4; i++) {
        dispatchKey("y");
        // Let each attempt settle (await mutation rejection + re-render) before
        // sending the next key.
        await Promise.resolve();
        await Promise.resolve();
      }
      result = await p;
    });

    expect(result).toEqual({ ok: false, reason: "max-retries" });
    expect(mutation.mock.calls.length).toBe(4);
  });

  test("external RV change while modal open → banner appears", async () => {
    const mutation = mock(async (_token: { readonly ifMatch: string; readonly id: string }) => "x");
    const harness = await renderHarness(mutation);
    let promise: Promise<ConfirmAndMutateResult<string>> | undefined;

    await act(async () => {
      promise = harness.invoke();
      await Promise.resolve();
      // Modal is open with snapshot RV=5; emit a new RV from the bus.
      harness.bus.set("AgentSession", "sess-1", { ...FAKE_ENTITY, resourceVersion: "6" });
      await Promise.resolve();
    });

    const output = harness.tree.toJSON();
    expect(JSON.stringify(output)).toContain("state changed externally");

    // Cancel to let the promise resolve cleanly.
    await act(async () => {
      dispatchKey("n");
      await promise;
    });
  });
});
