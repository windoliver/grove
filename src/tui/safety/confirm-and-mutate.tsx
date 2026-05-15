/**
 * ConfirmAndMutateProvider + useConfirmAndMutate hook + modal (C6 #304).
 *
 * Singleton React provider mounted at the TUI app root. Owns the modal
 * state machine, the live concurrent-mutation banner, the 409 retry loop,
 * and the `DangerousToken` minting. Callers invoke `useConfirmAndMutate()`
 * to obtain a `trigger(req)` function whose promise resolves with either
 * `{ ok: true, value }` or `{ ok: false, reason }`.
 *
 * Why a single provider, not per-call modal: every dangerous mutation goes
 * through the same UI pattern (snapshot, banner, retry). Centralizing the
 * state machine here is what makes the `DangerousToken` brand a useful
 * compile-time guarantee — callers cannot mint tokens outside the
 * `safety/` package, so they cannot call dangerous client methods without
 * going through this provider.
 *
 * State machine (see spec §6 "Data flow"):
 *   IDLE → OPEN          on trigger(req)
 *   OPEN → SUBMITTING    on 'y' keypress
 *   SUBMITTING → IDLE    on mutation ok        (resolve { ok: true, value })
 *   SUBMITTING → OPEN    on 409 + retryCount<3 (banner=true, snapshot RV updated)
 *   SUBMITTING → IDLE    on 409 + retryCount=3 (resolve { ok: false, reason: max-retries })
 *   OPEN → IDLE          on 'n' keypress       (resolve { ok: false, reason: cancelled })
 *   OPEN → OPEN          on 'r' keypress       (manual refresh: snapshot = live, banner=false)
 *
 * Retry math: MAX_RETRIES = 3 retries AFTER the first attempt → 4 attempts
 * total. The 4th 409 in a row resolves with `max-retries`. This matches
 * `withIfMatch`'s `maxRetries + 1` semantics (`src/core/with-if-match.ts`).
 *
 * Entity-bus injection: the provider takes a `ConfirmAndMutateEntityBus`
 * prop so tests can wire an in-memory fake. T11 will add a default that
 * adapts the production `EntityStoreFactory` (via `EntityStoreContext`).
 * Decoupling the provider from the watch infrastructure keeps unit tests
 * lightweight and lets the singleton mount even in pages that haven't
 * subscribed to a particular kind.
 */

import { useKeyboard } from "@opentui/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { EntityForKind } from "../../core/informer.js";
import type { WatchKind } from "../../core/watch-events.js";
import { theme } from "../theme.js";
import type { DangerousToken } from "./internal/token.js";
import { mintDangerousToken } from "./internal/token.js";

const MAX_RETRIES = 3;
const BANNER_TEXT = "state changed externally — review before confirming";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A request to confirm-and-mutate. The caller hands in the entity snapshot
 * (from the cursor row or any in-process source), a human-readable message,
 * and a mutation function. The mutation receives a `DangerousToken` whose
 * `ifMatch` is the snapshot's `resourceVersion`; the client methods
 * (`setGoalHttp`, `archiveSessionHttp`, etc.) read `token.ifMatch` and set
 * the `If-Match` header on the request.
 */
export interface ConfirmAndMutateRequest<K extends WatchKind, R> {
  readonly entity: EntityForKind<K>;
  readonly message: string;
  /** Marker — only dangerous mutations route through this primitive. */
  readonly dangerous: true;
  readonly mutation: (token: DangerousToken<K>) => Promise<R>;
  /** Optional renderer for a prev→next diff. Reserved for follow-ups. */
  readonly diff?: (prev: EntityForKind<K>, next: EntityForKind<K>) => ReactNode;
}

export type ConfirmAndMutateResult<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly reason: "cancelled" | "max-retries" };

/**
 * Subscription contract for the live-entity feed. Production wraps the
 * `EntityStoreFactory` (T11); tests pass an in-memory fake.
 *
 * `get` returns the current cached entity (synchronous read).
 * `subscribe` registers a callback fired on every entity update for the
 * (kind, id) pair. The callback receives the new entity (or undefined if
 * deleted). Returns an unsubscribe function.
 */
export interface ConfirmAndMutateEntityBus {
  get<K extends WatchKind>(kind: K, id: string): EntityForKind<K> | undefined;
  subscribe<K extends WatchKind>(
    kind: K,
    id: string,
    cb: (entity: EntityForKind<K> | undefined) => void,
  ): () => void;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * Wide-typed internal state. The provider trafficks in `WatchKind` after
 * the hook's generic type-check; the modal only needs `kind`/`id`/`RV`.
 * Casts to the caller's K happen at the `mintDangerousToken` call site.
 *
 * `reject` is invoked for non-conflict errors so the caller's try/catch
 * surfaces the failure (per C6 spec §6, T11 critical item C). 409s and
 * cancel/max-retries still resolve the discriminated union.
 */
interface ActiveRequest {
  readonly request: ConfirmAndMutateRequest<WatchKind, unknown>;
  readonly resolve: (r: ConfirmAndMutateResult<unknown>) => void;
  readonly reject: (err: unknown) => void;
}

interface ModalState {
  readonly request: ConfirmAndMutateRequest<WatchKind, unknown> | null;
  readonly snapshot: EntityForKind<WatchKind> | null;
  readonly liveResourceVersion: string | null;
  readonly banner: boolean;
  readonly retryCount: number;
  readonly submitting: boolean;
}

const INITIAL_STATE: ModalState = {
  request: null,
  snapshot: null,
  liveResourceVersion: null,
  banner: false,
  retryCount: 0,
  submitting: false,
};

// ---------------------------------------------------------------------------
// Context — the hook returns the trigger function from this context
// ---------------------------------------------------------------------------

type TriggerFn = <K extends WatchKind, R>(
  req: ConfirmAndMutateRequest<K, R>,
) => Promise<ConfirmAndMutateResult<R>>;

const ConfirmAndMutateContext = createContext<TriggerFn | null>(null);
ConfirmAndMutateContext.displayName = "ConfirmAndMutateContext";

/**
 * Returns a function the caller invokes for each dangerous mutation:
 *
 *   const confirmAndMutate = useConfirmAndMutate();
 *   const result = await confirmAndMutate({
 *     entity, message: "Delete?", dangerous: true,
 *     mutation: (token) => client.archiveSession(token),
 *   });
 *
 * Throws if no provider is mounted — this is by design: a missing provider
 * means a callsite shipped without the safety net, and the visible crash
 * is preferable to silent direct mutation.
 */
export function useConfirmAndMutate(): TriggerFn {
  const trigger = useContext(ConfirmAndMutateContext);
  if (!trigger) {
    throw new Error(
      "useConfirmAndMutate: no <ConfirmAndMutateProvider> mounted. " +
        "Wrap your app root (see pages-router.tsx).",
    );
  }
  return trigger;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ConfirmAndMutateProviderProps {
  readonly children: ReactNode;
  /**
   * Live-entity feed used to detect concurrent mutations. The provider
   * subscribes to `(snapshot.kind, snapshot.id)` whenever the modal opens
   * and sets `banner=true` when the live RV diverges from the snapshot RV.
   *
   * Required in production (wired via `makeEntityBusFromStore` in
   * `pages-router.tsx`). Tests pass a `FakeEntityBus`. Making it required
   * keeps the safety net's banner always-on for production paths so a
   * concurrent mutation while the modal is open is never silently dropped.
   */
  readonly entityBus: ConfirmAndMutateEntityBus;
}

export function ConfirmAndMutateProvider(props: ConfirmAndMutateProviderProps): ReactNode {
  const { children, entityBus } = props;
  const [state, setState] = useState<ModalState>(INITIAL_STATE);

  // Mirror the rendered state in a ref so async callbacks (`submit`,
  // keyboard handler) read the freshest snapshot/retryCount even when
  // they were registered before the latest setState committed. Without
  // this, `useKeyboard`'s captured handler closes over the initial state
  // and `submit` sees stale values mid-409-retry.
  const stateRef = useRef<ModalState>(INITIAL_STATE);
  stateRef.current = state;

  // Hold the pending request's resolve callback outside React state so the
  // keyboard handler — which is a stable closure — can resolve the promise
  // without re-creating itself on every state change.
  const activeRef = useRef<ActiveRequest | null>(null);

  // ---------------------------------------------------------------------
  // close: shared exit path. Resolves the pending promise and resets state.
  // The ref is updated synchronously alongside setState so a key dispatch
  // arriving in the same tick after close (e.g. the test's max-retries
  // burst) sees the modal as closed and short-circuits.
  // ---------------------------------------------------------------------
  const close = useCallback((result: ConfirmAndMutateResult<unknown>): void => {
    const active = activeRef.current;
    activeRef.current = null;
    stateRef.current = INITIAL_STATE;
    setState(INITIAL_STATE);
    if (active) active.resolve(result);
  }, []);

  // Mirror of `close` that rejects the pending promise instead of resolving
  // with a discriminated-union failure. Used for non-409 errors so callers'
  // try/catch surfaces the underlying failure (e.g., network error, 5xx) to
  // a flash bar (C6 spec §6, T11 critical item C).
  const fail = useCallback((err: unknown): void => {
    const active = activeRef.current;
    activeRef.current = null;
    stateRef.current = INITIAL_STATE;
    setState(INITIAL_STATE);
    if (active) active.reject(err);
  }, []);

  // ---------------------------------------------------------------------
  // trigger: stable identity (no state deps) so callers can put it in
  // useEffect/useCallback dependency arrays without thrash.
  //
  // The ref is the load-bearing path: `stateRef.current` is updated
  // synchronously here so that key dispatches firing in the same tick as
  // `trigger()` (e.g. tests) observe the open modal even before React
  // commits the corresponding setState. The setState is still needed so
  // the modal mounts in the React tree.
  // ---------------------------------------------------------------------
  const trigger = useCallback<TriggerFn>(
    <K extends WatchKind, R>(req: ConfirmAndMutateRequest<K, R>) => {
      return new Promise<ConfirmAndMutateResult<R>>((resolve, reject) => {
        const wideReq = req as unknown as ConfirmAndMutateRequest<WatchKind, unknown>;
        activeRef.current = {
          request: wideReq,
          resolve: resolve as (r: ConfirmAndMutateResult<unknown>) => void,
          reject,
        };
        const openState: ModalState = {
          request: wideReq,
          snapshot: wideReq.entity,
          liveResourceVersion: wideReq.entity.resourceVersion,
          banner: false,
          retryCount: 0,
          submitting: false,
        };
        // Mirror into the ref BEFORE setState so dispatches in the same
        // microtask see the open state even if React hasn't re-rendered.
        stateRef.current = openState;
        setState(openState);
      });
    },
    [],
  );

  // ---------------------------------------------------------------------
  // submit: mint a token from the current snapshot and run the mutation.
  // On 409, update the snapshot from the response and either re-open the
  // modal for retry or resolve with max-retries.
  // ---------------------------------------------------------------------
  const submit = useCallback(async (): Promise<void> => {
    const active = activeRef.current;
    if (!active) return;
    // Read the latest snapshot/retryCount from the ref. The closure of
    // useCallback captures the initial state, so we must indirect through
    // a ref to see post-409 RV bumps.
    const current = stateRef.current;
    const snap = current.snapshot;
    const retryCount = current.retryCount;
    if (!snap) return;
    setState((s) => ({ ...s, submitting: true }));
    const token = mintDangerousToken(snap.kind, snap.id, snap.resourceVersion);
    try {
      const value = await active.request.mutation(token);
      close({ ok: true, value });
    } catch (err) {
      const conflict = parseConflict(err);
      if (!conflict) {
        // Non-409: reject the trigger promise so the caller's try/catch
        // sees the underlying error (network failure, 5xx, ...) and can
        // surface it via a flash bar. The provider does NOT collapse the
        // failure into a "cancelled" result — that would silently swallow
        // real errors. See C6 spec §6 and T11 critical item C.
        fail(err);
        return;
      }
      // 409: bump retry count + update snapshot RV. The retry-limit math
      // mirrors withIfMatch: MAX_RETRIES retries AFTER the first attempt
      // means total attempts = MAX_RETRIES + 1 = 4. After the 4th failure
      // (retryCount === 3 entering submit) we give up.
      if (retryCount >= MAX_RETRIES) {
        close({ ok: false, reason: "max-retries" });
        return;
      }
      const prior = stateRef.current;
      if (!prior.snapshot) return;
      const nextState: ModalState = {
        ...prior,
        snapshot: {
          ...prior.snapshot,
          resourceVersion: conflict.current.resourceVersion,
        } as EntityForKind<WatchKind>,
        liveResourceVersion: conflict.current.resourceVersion,
        banner: true,
        retryCount: prior.retryCount + 1,
        submitting: false,
      };
      // Mirror ref before setState so a subsequent dispatch in the same
      // tick (the test's retry burst) reads the bumped retryCount and
      // fresh RV when it calls submit.
      stateRef.current = nextState;
      setState(nextState);
    }
  }, [close, fail]);

  // ---------------------------------------------------------------------
  // Live-entity subscription — drives the "external mutation" banner
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!state.snapshot) return;
    const { kind, id } = state.snapshot;
    // Pull the current value immediately in case a write happened between
    // open-time and subscribe-time. The watch-store API delivers events
    // post-subscribe; the initial get() closes the race window.
    const initial = entityBus.get(kind, id);
    if (initial) {
      setState((s) => {
        if (!s.snapshot) return s;
        if (initial.resourceVersion === s.snapshot.resourceVersion) return s;
        return { ...s, liveResourceVersion: initial.resourceVersion, banner: true };
      });
    }
    const unsubscribe = entityBus.subscribe(kind, id, (entity) => {
      if (!entity) return;
      setState((s) => {
        if (!s.snapshot) return s;
        if (entity.resourceVersion === s.snapshot.resourceVersion) {
          return s;
        }
        return {
          ...s,
          liveResourceVersion: entity.resourceVersion,
          banner: true,
        };
      });
    });
    return unsubscribe;
    // We re-subscribe whenever the snapshot identity changes (open/close,
    // 409 RV bump). The bus reference is captured at mount time; swapping
    // it after mount is not a supported use case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityBus, state.snapshot]);

  // ---------------------------------------------------------------------
  // Keyboard routing — only active when the modal is open
  // ---------------------------------------------------------------------
  useKeyboard((key) => {
    // Read from the ref so we route keys against the latest state even when
    // useKeyboard's captured handler predates a setState commit. The
    // re-registration on each render is best-effort; the ref is the
    // load-bearing source of truth.
    const cur = stateRef.current;
    if (!cur.request) return;
    if (cur.submitting) return;
    const name = key.name;
    if (name === "y") {
      void submit();
      return;
    }
    if (name === "n" || name === "escape") {
      close({ ok: false, reason: "cancelled" });
      return;
    }
    if (name === "r" && cur.snapshot) {
      // Manual refresh: pull the latest from the bus into the snapshot,
      // clear the banner. Does not submit.
      const fresh = entityBus.get(cur.snapshot.kind, cur.snapshot.id);
      if (fresh) {
        setState((s) => ({
          ...s,
          snapshot: fresh as EntityForKind<WatchKind>,
          liveResourceVersion: fresh.resourceVersion,
          banner: false,
        }));
      }
    }
  });

  return (
    <ConfirmAndMutateContext.Provider value={trigger}>
      {children}
      {state.request && state.snapshot && (
        <ConfirmAndMutateModal
          message={state.request.message}
          snapshot={state.snapshot}
          banner={state.banner}
          liveResourceVersion={state.liveResourceVersion}
        />
      )}
    </ConfirmAndMutateContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Modal — presentational; provider owns all state and key routing
// ---------------------------------------------------------------------------

interface ModalProps {
  readonly message: string;
  readonly snapshot: EntityForKind<WatchKind>;
  readonly banner: boolean;
  readonly liveResourceVersion: string | null;
}

function ConfirmAndMutateModal(props: ModalProps): ReactNode {
  const { message, snapshot, banner, liveResourceVersion } = props;
  return (
    <box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      borderStyle="single"
      borderColor={theme.focus}
    >
      <text bold color={theme.focus}>
        {`Confirm: ${message}`}
      </text>
      <text color={theme.text}>{`Kind: ${snapshot.kind}`}</text>
      <text color={theme.text}>{`Id:   ${snapshot.id}`}</text>
      <text color={theme.secondary}>{`rv:   ${snapshot.resourceVersion}`}</text>
      {banner && (
        <box marginTop={1} flexDirection="column">
          <text color={theme.warning}>{`⚠ ${BANNER_TEXT}`}</text>
          <text color={theme.secondary}>
            {`was rv=${snapshot.resourceVersion} → now rv=${liveResourceVersion ?? "?"}`}
          </text>
        </box>
      )}
      <text color={theme.secondary}>[y] confirm [n] cancel [r] refresh snapshot</text>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Error parsing — extract { resourceVersion, generation } from a 409
// ---------------------------------------------------------------------------

interface ConflictPayload {
  readonly current: {
    readonly resourceVersion: string;
    readonly generation: number;
  };
}

/**
 * Detect a CAS conflict in an error thrown by the mutation function.
 *
 * Accepts either:
 *   - `err.status === 409 && err.current === { resourceVersion, generation }`
 *     (the shape T11 will produce from the HTTP client error path)
 *   - `err.kind === "rv-mismatch" && err.current === ...`
 *     (the shape an in-process caller might throw directly)
 *
 * Returns null for anything else — the provider treats null as a generic
 * failure and surfaces it without a retry attempt.
 */
function parseConflict(err: unknown): ConflictPayload | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  const current = e.current;
  if (!current || typeof current !== "object") return null;
  const c = current as Record<string, unknown>;
  const rv = c.resourceVersion;
  const gen = c.generation;
  if (typeof rv !== "string" || typeof gen !== "number") return null;
  // Either status=409 or kind="rv-mismatch" is sufficient evidence.
  if (e.status === 409 || e.kind === "rv-mismatch") {
    return { current: { resourceVersion: rv, generation: gen } };
  }
  return null;
}
