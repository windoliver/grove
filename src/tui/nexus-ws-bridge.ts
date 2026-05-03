/**
 * Nexus IPC bridge — real-time push via Nexus SSE + RPC.
 *
 * Endpoints used (post-2026-04-27 — Nexus PR #3912 deleted the legacy
 * `/api/v2/ipc/*` router; IPC is now kernel-VFS-as-IPC over the RPC
 * surface and the events_replay SSE stream):
 *   GET  /api/v2/events/stream         — SSE stream of file-write events
 *                                        filtered by `path_pattern` to the
 *                                        per-role inbox prefix
 *   POST /api/nfs/sys_write            — RPC: write a message file into
 *                                        the recipient's inbox directory
 *   POST /api/nfs/sys_read             — RPC: read the message file when
 *                                        an SSE event references it
 *   POST /api/v2/agents/register       — register agent (auto-provisions
 *                                        the `/ipc/{agent_id}/inbox/` dir
 *                                        per agent_registration.py:236+)
 *
 * Flow: SSE delivers `event` records (shape from `EventReplayService`) for
 * any `write` to a path matching the per-role inbox glob (any-zone-prefix +
 * `/ipc/{role}/inbox/`) → bridge translates to the legacy `SseEvent` shape
 * internally → reads message via sys_read → pushes to target agent via
 * runtime.send().
 *
 * No process.stderr.write — all logging goes through the TUI's log system
 * to avoid corrupting the alternate screen.
 */

import type { AgentRuntime, AgentSession } from "../core/agent-runtime.js";
import type { EventBus, GroveEvent } from "../core/event-bus.js";
import type { HandoffStore } from "../core/handoff.js";
import { getProcessInstanceId } from "../core/process-instance.js";
import type { AgentTopology } from "../core/topology.js";
import type { NexusIpcClient } from "../nexus/nexus-ipc-client.js";
import { debugLog } from "./debug-log.js";

export interface NexusWsBridgeOptions {
  topology: AgentTopology;
  runtime: AgentRuntime;
  nexusUrl: string;
  apiKey: string;
  /** EventBus to notify the TUI when SSE events arrive (triggers data refresh). */
  eventBus?: EventBus | undefined;
  /** Called before delivering IPC to an agent — use for workspace rsync. */
  onBeforeDeliver?: ((sender: string, recipient: string) => void) | undefined;
  /** HandoffStore for updating delivery status on SSE events. */
  handoffStore?: HandoffStore | undefined;
  /** Shared IPC client — replaces inline fetch when provided. */
  ipcClient?: NexusIpcClient | undefined;
  /**
   * Forwards inner payloads whose `type` is "acp.message" or "acp.result"
   * to a typed consumer (AcpMessageSink). Called only when the event's
   * sourceRole is NOT one of this TUI's local topology roles — the
   * in-process NexusEventBus subscription handles local roles, so SSE
   * forwarding for the same event would double-count.
   */
  onAcpEvent?: ((event: GroveEvent) => void) | undefined;
  /**
   * Stable per-process identifier. When both publisher and bridge are
   * configured with the same value, the SSE loopback dedupe is gated on
   * instance identity rather than role-name equality — so shared-Nexus
   * deployments with role-name collisions across processes still receive
   * each other's typed events. When omitted, falls back to role-name
   * dedupe (preserves single-process behavior for older wiring).
   */
  localInstanceId?: string | undefined;
  /**
   * Called when post-startup SSE reconnection for a role fails more than
   * `unhealthyThreshold` consecutive times. Lets the caller (SpawnManager /
   * tui-app) transition to a fail-closed degraded state instead of letting
   * the silent reconnect loop mask a sustained outage. Without this,
   * post-start auth/network regressions would stop delivery while the
   * TUI kept accepting work.
   */
  onRoleUnhealthy?: ((role: string, consecutiveFailures: number) => void) | undefined;
  /** Default: 3. */
  unhealthyThreshold?: number | undefined;
}

interface SseEvent {
  event: string;
  message_id: string;
  sender: string;
  recipient: string;
  type: string;
  path: string;
}

/**
 * Shape returned by Nexus' EventReplayService over `/api/v2/events/stream`
 * (see `src/nexus/services/event_log/replay.py` `EventRecord.to_dict`).
 * The bridge translates this into the legacy `SseEvent` shape its handler
 * already expects.
 */
interface EventRecordPayload {
  event_id: string;
  type: string;
  path: string;
  agent_id?: string | undefined;
  zone_id?: string | undefined;
  timestamp?: string | undefined;
  sequence_number?: number | undefined;
}

/** URL builder for the per-role inbox subscription on the new events SSE. */
function inboxStreamUrl(nexusUrl: string, role: string): string {
  // path_pattern is matched (SQL LIKE) against the stored zone-prefixed path.
  // `*/ipc/{role}/inbox/*` → `%/ipc/{role}/inbox/%` covers any zone.
  const pattern = `*/ipc/${role}/inbox/*`;
  const params = new URLSearchParams({
    path_pattern: pattern,
    event_types: "write",
  });
  return `${nexusUrl}/api/v2/events/stream?${params.toString()}`;
}

/**
 * Strip a leading `/zone/{zone_id}/` prefix from a stored event path so the
 * remaining path can be passed to `sys_read` (which re-applies zone scoping
 * via the RPC dispatcher). Returns the original path when no prefix matches.
 */
function stripZonePrefix(path: string): string {
  // `/zone/<id>/<rest>` → `/<rest>`. The id is opaque (uuid/string), so we
  // only strip when the path starts with `/zone/` and has at least one more
  // segment before the rest of the path.
  const match = path.match(/^\/zone\/[^/]+(\/.*)$/);
  return match ? (match[1] ?? path) : path;
}

/** Build the inbox file path for a recipient role. */
function inboxFilePath(recipient: string, messageId: string): string {
  return `/ipc/${recipient}/inbox/${messageId}.json`;
}

export class NexusWsBridge {
  private readonly opts: NexusWsBridgeOptions;
  private readonly localInstanceId: string;
  private readonly sessions = new Map<string, AgentSession>();
  // Active per-connect controllers. Each connectSse attempt creates one
  // and removes it in finally so long-running bridges don't accumulate
  // controllers across reconnect churn. A Set rather than array keeps
  // removal O(1).
  private abortControllers = new Set<AbortController>();
  // Per-role cancellation token. When a role is unregistered (or re-registered),
  // its old SSE loop must exit — otherwise a stale loop can keep incrementing
  // its consecutive-failure counter and fire onRoleUnhealthy for a role the
  // caller has already torn down, incorrectly flipping delivery to disabled.
  private roleAborts = new Map<string, AbortController>();
  // Per-role recent-message cache: rejects duplicate deliveries of the
  // same Nexus message_id through the same role. Re-registering a role
  // (kill + respawn) aborts the old SSE loop but cannot guarantee the
  // old loop has finished dispatching its in-flight event before the
  // new loop connects. Both may observe the same message_delivered
  // during the handoff window. Without dedupe the runtime would receive
  // the prompt twice. Bounded per role to keep memory flat.
  private recentMessageIds = new Map<string, Set<string>>();
  private static readonly RECENT_CAP = 256;
  // Unresolved-dead-letter queue: when a local push fails but correlation
  // could not be resolved even after in-line retry (linkage race or
  // transient store outage), the pending entry is queued here so a
  // periodic reconciler can re-resolve once the ipcMessageId ↔ handoff
  // link lands, and then dead-letter the correct record. Without this,
  // failed handoffs silently remain in stale `delivered`/`pending_pickup`
  // state and recovery tooling is blind to the gap. Bounded to keep
  // memory flat under prolonged outage.
  private pendingDeadLetters: Array<{
    ipcMessageId: string;
    targetRole: string;
    sender: string | undefined;
    sourceCid: string | undefined;
    reason: string;
    attempts: number;
    lastAttemptAt: number;
  }> = [];
  private static readonly PENDING_DLQ_CAP = 1024;
  private static readonly PENDING_DLQ_MAX_ATTEMPTS = 20;
  private static readonly PENDING_DLQ_INTERVAL_MS = 30000;
  private pendingDlqTimer: ReturnType<typeof setInterval> | null = null;
  // Single-flight drain lock: prevents overlapping drain runs from
  // double-incrementing entry.attempts and racing removals. Timer ticks
  // that fire while a drain is already in progress become no-ops.
  private pendingDlqDrainInFlight = false;
  // Two-phase teardown state. Flipped to true by shutdown() before the
  // final drain so new enqueues during the flush window are rejected
  // (otherwise readAndPush racing with shutdown could append entries
  // the flush then clears without reconciling).
  private draining = false;
  private closed = false;
  // In-flight runtime.send promises. shutdown() awaits these (bounded)
  // before the final drain so a send failing after shutdown can still
  // enqueue and be reconciled by the drain loop. Without tracking
  // these, a late runtime.send failure would either be dropped (closed
  // guard in enqueue) or never reach the drain loop at all.
  private inFlightSends = new Set<Promise<void>>();
  // Single-flight shutdown latch. Concurrent shutdown() callers await
  // the same in-progress teardown instead of racing each other (a
  // second caller entering while the first is mid-drain could close()
  // and clear the queue before the first finishes).
  private shutdownPromise: Promise<void> | null = null;

  constructor(opts: NexusWsBridgeOptions) {
    this.opts = opts;
    // Default to the process-wide id so the bridge always carries a marker,
    // matching the publisher's default. This closes the "legacy publisher
    // without marker" blind spot in strict-dedupe mode — every in-process
    // event carries the same id on both sides, cross-process events
    // necessarily differ, and pure role-name fallback is only active in
    // tests that explicitly opt out by constructing with no localInstanceId.
    this.localInstanceId = opts.localInstanceId ?? getProcessInstanceId();
    this.pendingDlqTimer = setInterval(() => {
      void this.drainPendingDeadLetters();
    }, NexusWsBridge.PENDING_DLQ_INTERVAL_MS);
    // Don't hold the event loop open for this timer alone.
    const timer = this.pendingDlqTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  /**
   * Role names this bridge was constructed against. Used by SpawnManager
   * to detect a topology drift where the bridge was provisioned/probed
   * for a prior role set before attaching (e.g. topology changed while
   * bridge init was in flight). An attached bridge whose role set no
   * longer matches the current topology cannot safely service spawns —
   * registration, SSE, and health are all per-role and scoped to
   * construction-time topology.
   */
  getProvisionedRoleNames(): readonly string[] {
    return this.opts.topology.roles.map((r) => r.name);
  }

  registerSession(role: string, session: AgentSession): void {
    this.sessions.set(role, session);
    if (!this.closed) {
      // Cancel any prior loop for this role so we don't run two concurrent
      // reconnect loops against the same Nexus stream after a re-register.
      const prior = this.roleAborts.get(role);
      if (prior) prior.abort();
      const controller = new AbortController();
      this.roleAborts.set(role, controller);
      void this.startSseForRole(role, controller.signal);
    }
  }

  /**
   * Remove the session binding for a role and cancel its SSE loop.
   *
   * When `expectedSessionId` is provided, the removal is ownership-checked:
   * if the currently-registered session for that role has a different id
   * (e.g. a later spawn already replaced it, or a sibling same-role spawn
   * re-registered), this is a no-op. This prevents `kill(oldSpawnId)` from
   * cutting off a still-live sibling spawn that shares the role name —
   * the bridge maps one session per role, so unconditional removal on
   * kill would take down the surviving binding.
   */
  unregisterSession(role: string, expectedSessionId?: string): void {
    if (expectedSessionId !== undefined) {
      const current = this.sessions.get(role);
      if (!current || current.id !== expectedSessionId) return;
    }
    this.sessions.delete(role);
    const controller = this.roleAborts.get(role);
    if (controller) {
      controller.abort();
      this.roleAborts.delete(role);
    }
    this.recentMessageIds.delete(role);
  }

  /**
   * Provision agents for all topology roles and prepare SSE streams.
   * Resolves only when EVERY role has successfully registered with Nexus
   * (not just one — a single-role quorum would mask partial outages
   * where some roles become undeliverable). Rejects on first failing
   * role or on overall timeout so callers can treat the bridge as a
   * startup invariant and avoid a silent no-delivery state.
   */
  async connect(timeoutMs = 10000): Promise<void> {
    if (this.closed) return;
    const regFailures = await this.provisionAgents(timeoutMs);
    if (regFailures.length > 0) {
      const detail = regFailures.map((f) => `${f.role}: ${f.reason}`).join("; ");
      throw new Error(`NexusWsBridge: registration failed for role(s) [${detail}]`);
    }
    // Registration alone doesn't prove the SSE stream endpoint is authorized
    // and serving per role — some deployments accept registration but 403/500
    // the stream. Probe every role's stream with a short-lived HEAD/GET and
    // treat any non-2xx as a readiness failure, matching the "no silent
    // partial outage" contract. The abort after status check ensures we
    // don't consume stream bytes during readiness.
    const streamFailures = await this.probeStreams(timeoutMs);
    if (streamFailures.length > 0) {
      const detail = streamFailures.map((f) => `${f.role}: ${f.reason}`).join("; ");
      throw new Error(`NexusWsBridge: stream handshake failed for role(s) [${detail}]`);
    }
  }

  private async probeStreams(timeoutMs: number): Promise<Array<{ role: string; reason: string }>> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const results = await Promise.all(
      this.opts.topology.roles.map(async (role) => {
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        deadline.addEventListener("abort", onAbort, { once: true });
        try {
          const resp = await fetch(inboxStreamUrl(this.opts.nexusUrl, role.name), {
            headers: {
              Authorization: `Bearer ${this.opts.apiKey}`,
              Accept: "text/event-stream",
            },
            signal: ac.signal,
          });
          if (!resp.ok) return { role: role.name, reason: `HTTP ${resp.status}` };
          // 2xx is necessary but not sufficient — a misconfigured proxy can
          // serve a success status without an actual event stream. Verify
          // the response carries a body AND identifies as text/event-stream
          // so readiness matches the invariant the runtime stream loop
          // relies on (resp.body.getReader() + SSE framing).
          if (!resp.body) return { role: role.name, reason: "no response body" };
          const ctype = resp.headers.get("content-type") ?? "";
          if (!ctype.toLowerCase().includes("text/event-stream")) {
            return { role: role.name, reason: `not event-stream (content-type=${ctype})` };
          }
          return null;
        } catch (err) {
          const reason =
            err instanceof Error
              ? err.name === "TimeoutError" || err.name === "AbortError"
                ? `stream timeout after ${timeoutMs}ms`
                : err.message
              : String(err);
          return { role: role.name, reason };
        } finally {
          ac.abort(); // don't hold the stream open
          deadline.removeEventListener("abort", onAbort);
        }
      }),
    );
    return results.filter((r): r is { role: string; reason: string } => r !== null);
  }

  close(): void {
    // Reentrancy guard: when shutdown() is active, it owns the queue
    // (has its own deadline-bounded drain loop and final clear). A
    // concurrent or internal close() call must not touch
    // pendingDeadLetters or the drain would lose entries mid-flight.
    // The shutdown itself invokes close() at the end as a last step;
    // at that point the drain is done and the queue is already
    // cleared, so no-op on the queue is correct.
    const shutdownOwnsQueue = this.shutdownPromise !== null;
    this.closed = true;
    if (this.pendingDlqTimer !== null) {
      clearInterval(this.pendingDlqTimer);
      this.pendingDlqTimer = null;
    }
    // Queue handling:
    //   - shutdown() owns the queue after draining=true: it runs a
    //     deadline-bounded drain loop and then clears in its own
    //     finalize. close() MUST NOT touch pendingDeadLetters while
    //     shutdown is active or entries can be lost mid-drain.
    //   - Non-shutdown close() (React unmount destroy() path): fire
    //     a detached best-effort final drain. Callers that need
    //     durability guarantees should await shutdown() instead.
    if (shutdownOwnsQueue) {
      // No-op: shutdown() owns pendingDeadLetters.
    } else if (!this.draining && this.pendingDeadLetters.length > 0) {
      void this.flushPendingDeadLettersThenLog(5000);
    } else if (this.draining) {
      // Already drained by shutdown(); residual entries (if any) were
      // logged there. Just clear to release memory.
      this.pendingDeadLetters = [];
    }
    for (const ac of this.abortControllers) {
      ac.abort();
    }
    this.abortControllers.clear();
    for (const ac of this.roleAborts.values()) {
      ac.abort();
    }
    this.roleAborts.clear();
    this.recentMessageIds.clear();
    this.sessions.clear();
  }

  /** Send an IPC message from one agent to another via Nexus. */
  async send(
    sender: string,
    recipient: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    // Use shared NexusIpcClient when available (5A: DRY)
    if (this.opts.ipcClient) {
      const result = await this.opts.ipcClient.send(sender, recipient, payload);
      return result.ok;
    }
    // Fallback: direct write to the recipient's inbox via Nexus RPC
    // (`sys_write`). The legacy `/api/v2/ipc/send` route was removed when
    // Nexus migrated IPC to the kernel-VFS surface.
    try {
      const messageId = (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
      const envelope = JSON.stringify({
        message_id: messageId,
        sender,
        recipient,
        type: "event",
        payload,
        timestamp: new Date().toISOString(),
      });
      const buf = Buffer.from(envelope, "utf8").toString("base64");
      const resp = await fetch(`${this.opts.nexusUrl}/api/nfs/sys_write`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "sys_write",
          params: { path: inboxFilePath(recipient, messageId), buf },
          id: 1,
        }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** Register agents in Nexus so their inboxes are provisioned. */
  /**
   * Registers every topology role with Nexus, in parallel, under a shared
   * timeout. Returns the list of failures (empty when all succeeded). The
   * caller uses an empty return to gate "bridge ready" — any non-2xx,
   * network error, or timeout for any role is a partial outage and must
   * block startup.
   */
  private async provisionAgents(
    timeoutMs: number,
  ): Promise<Array<{ role: string; reason: string }>> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const results = await Promise.all(
      this.opts.topology.roles.map(async (role) => {
        try {
          const resp = await fetch(`${this.opts.nexusUrl}/api/v2/agents/register`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.opts.apiKey}`,
            },
            body: JSON.stringify({
              agent_id: role.name,
              name: role.name,
              capabilities: [role.name],
            }),
            signal: deadline,
          });
          // 409 Conflict = "already registered" — idempotent success.
          // Some deployments pre-provision agents; a fatal role failure
          // on benign re-registration would block startup unnecessarily.
          if (!resp.ok && resp.status !== 409) {
            return { role: role.name, reason: `HTTP ${resp.status}` };
          }
          return null;
        } catch (err) {
          const reason =
            err instanceof Error
              ? err.name === "TimeoutError" || err.name === "AbortError"
                ? `timeout after ${timeoutMs}ms`
                : err.message
              : String(err);
          return { role: role.name, reason };
        }
      }),
    );
    return results.filter((r): r is { role: string; reason: string } => r !== null);
  }

  private async startSseForRole(role: string, signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    const threshold = this.opts.unhealthyThreshold ?? 3;
    // Re-arm the "fired once per breach" latch after any healthy cycle.
    // Without this, a later regression (single-role → multi-role
    // promotion, new topology with stricter requirements, or plain
    // recurrence) would never re-trigger onRoleUnhealthy because the
    // flag stayed latched from the first breach.
    let firedUnhealthy = false;
    while (!this.closed && !signal.aborted) {
      let streamOk = false;
      try {
        streamOk = await this.connectSse(role, signal);
      } catch {
        streamOk = false;
      }
      if (signal.aborted) return;
      if (streamOk) {
        consecutiveFailures = 0;
        firedUnhealthy = false;
      } else {
        consecutiveFailures += 1;
        // Gate escalation on the role still being live. A stale loop that
        // was cancelled mid-flight (unregister or re-register) must NOT
        // fire onRoleUnhealthy — the caller has already torn down that
        // role's session, and flipping delivery to disabled from a ghost
        // loop would be a false-positive outage signal.
        if (consecutiveFailures >= threshold && !firedUnhealthy && !signal.aborted) {
          firedUnhealthy = true;
          try {
            this.opts.onRoleUnhealthy?.(role, consecutiveFailures);
          } catch {
            // callback errors shouldn't kill the reconnect loop
          }
        }
      }
      if (!this.closed && !signal.aborted) {
        await new Promise<void>((resolve) => {
          // Wake early on abort so torn-down roles don't linger in the
          // reconnect backoff. When the timer fires the normal way, we
          // must remove the abort listener — otherwise each reconnect
          // cycle leaks a closure on the long-lived role signal.
          let onAbort: (() => void) | undefined;
          const timer = setTimeout(() => {
            if (onAbort) signal.removeEventListener("abort", onAbort);
            resolve();
          }, 5000);
          onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  }

  /**
   * Open an SSE stream for the role. Returns true when the stream
   * upgraded successfully and yielded at least one byte, false when
   * the server refused/rejected the stream, content-type mismatched,
   * or the stream stalled with no bytes for `idleReadMs`. Used by
   * startSseForRole to distinguish a real stream cycle from a failed
   * open or a hung half-open connection.
   */
  private async connectSse(role: string, roleSignal?: AbortSignal): Promise<boolean> {
    const ac = new AbortController();
    this.abortControllers.add(ac);
    // Forward role-level cancellation (unregister / re-register) into the
    // per-connection abort so the in-flight fetch and streaming read wind
    // down promptly instead of waiting for the idle watchdog.
    //
    // Listener MUST be removed when the attempt ends. `{ once: true }` only
    // clears the listener after it fires; on every normal reconnect cycle
    // the listener is stranded on the long-lived role signal. Over many
    // reconnects that accumulates closures and amplifies the abort fan-out
    // at teardown. Track the handler and remove it in the finally block.
    let forwardAbort: (() => void) | undefined;
    if (roleSignal) {
      if (roleSignal.aborted) ac.abort();
      else {
        forwardAbort = () => ac.abort();
        roleSignal.addEventListener("abort", forwardAbort, { once: true });
      }
    }
    try {
      // Open-phase deadline — a half-open TCP/TLS handshake or hung
      // backend would otherwise block the reconnect loop indefinitely
      // and prevent onRoleUnhealthy from ever firing.
      const openMs = 15000;
      const openTimer = setTimeout(() => ac.abort(), openMs);
      const url = inboxStreamUrl(this.opts.nexusUrl, role);

      let resp: Response;
      try {
        resp = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            Accept: "text/event-stream",
          },
          signal: ac.signal,
        });
      } finally {
        clearTimeout(openTimer);
      }

      if (!resp.ok || !resp.body) return false;
      // Same invariant the startup probe enforces: a 200 with wrong
      // content-type is not a valid stream. Without this check the
      // reconnect loop could keep marking misrouted responses as
      // "healthy cycles" and onRoleUnhealthy would never fire — exactly
      // the silent post-start outage the migration is supposed to surface.
      const ctype = resp.headers.get("content-type") ?? "";
      if (!ctype.toLowerCase().includes("text/event-stream")) return false;

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Transport health ≠ message arrival. A valid SSE stream may be
      // quiet for long stretches, emitting only keep-alive comments
      // (": ping\n") or nothing at all. Count the cycle healthy when
      // EITHER (a) we hold the stream open past the durability
      // threshold below, OR (b) we receive a real `message_delivered`
      // event before EOF.
      //
      // Just "saw bytes" is NOT enough — Nexus emits a `connected`
      // event immediately on stream open, so a misbehaving server or
      // proxy that accepts the request, hands back the connect frame,
      // and then EOFs would otherwise look healthy on every cycle and
      // the consecutive-failure counter would never advance. Require
      // either real delivery work OR a minimum healthy duration so a
      // tight connect/close loop still escalates to onRoleUnhealthy.
      let sawBytes = false;
      let sawDelivery = false;
      const cycleStartMs = Date.now();
      // Hold the stream open this long before treating bytes-only as a
      // healthy cycle. Comfortably above any plausible reverse-proxy
      // post-handshake timeout, comfortably below the 5 min idle
      // watchdog so a healthy idle stream still crosses the threshold.
      const minHealthyDurationMs = 30_000;
      const cycleDurable = (): boolean => Date.now() - cycleStartMs >= minHealthyDurationMs;
      const cycleHealthy = (): boolean => sawDelivery || (sawBytes && cycleDurable());
      // Idle-read watchdog — if the stream produces no bytes for this
      // long, abort and treat the cycle as unhealthy. Catches blackholed
      // proxies stuck mid-stream that hold the TCP pipe open without
      // delivering data.
      //
      // Set to 5 min because Nexus's `/api/v2/events/stream` does NOT
      // emit keep-alive comments — it sends a single `connected` event
      // then stays silent until an inbox-matching write lands. A shorter watchdog
      // (60 s) would treat every quiet stretch as an outage, escalate
      // through 3 reconnect cycles, and fire onRoleUnhealthy → flip
      // delivery to disabled even though the channel is healthy. 5 min
      // is well under Nexus's natural channel lifetime and still bounds
      // the time to detect a truly dead pipe.
      const idleReadMs = 300_000;
      // Track whether the abort was triggered by our idle watchdog.
      // When the watchdog fires mid-stream, sawBytes may already be
      // true from an earlier heartbeat, but the stream is still stalled
      // — we must report the cycle as unhealthy so the consecutive-
      // failure counter advances and onRoleUnhealthy fires eventually.
      let abortedByWatchdog = false;

      while (!this.closed) {
        const idleTimer = setTimeout(() => {
          abortedByWatchdog = true;
          ac.abort();
        }, idleReadMs);
        let readResult: Awaited<ReturnType<typeof reader.read>>;
        try {
          readResult = await reader.read();
        } catch {
          clearTimeout(idleTimer);
          // Watchdog fire AFTER the cycle is healthy (saw delivery, or
          // held open past the durability threshold) means the stream
          // was working and just went quiet — don't penalize. Otherwise
          // we couldn't prove the channel was ever delivering, so the
          // cycle is unhealthy.
          if (abortedByWatchdog && cycleHealthy()) return true;
          return abortedByWatchdog ? false : cycleHealthy();
        } finally {
          clearTimeout(idleTimer);
        }
        const { done, value } = readResult;
        if (done) break;
        if (value && value.byteLength > 0) sawBytes = true;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let eventType: string | null = null;
        let eventData: string | null = null;
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ")) {
            eventData = line.slice(6);
          } else if (line === "" && eventData) {
            // Post-PR-#3912 events_replay emits `event: event` for every
            // matched write. The legacy ipc-stream emitted
            // `event: message_delivered`. Treat both as delivery signals
            // so cycle-health accounting works against either backend.
            if (eventType === "event" || eventType === "message_delivered") sawDelivery = true;
            this.handleEvent(role, eventType, eventData);
            eventType = null;
            eventData = null;
          }
        }
      }
      // EOF path: server closed the stream cleanly. Count the cycle
      // healthy only if we had real delivery or held open long enough
      // to prove durability. A connect-and-close loop still escalates.
      return cycleHealthy();
    } finally {
      if (roleSignal && forwardAbort) {
        roleSignal.removeEventListener("abort", forwardAbort);
      }
      // Remove this attempt's controller from the active set so long-
      // running bridges don't accumulate controllers across reconnect
      // churn. Safe even when close() already cleared the set.
      this.abortControllers.delete(ac);
    }
  }

  private handleEvent(role: string, eventType: string | null, raw: string): void {
    try {
      // Accept both the legacy `message_delivered` envelope and the new
      // events_replay `event` envelope (post-PR-#3912). The new payload is
      // an EventRecord describing a file write — translate it to the
      // SseEvent shape the rest of the pipeline already speaks.
      let event: SseEvent;
      if (eventType === "message_delivered") {
        event = JSON.parse(raw) as SseEvent;
      } else if (eventType === "event") {
        const rec = JSON.parse(raw) as EventRecordPayload;
        // Filter to file-write ops on inbox files. The path_pattern query
        // param already constrains the SSE feed to writes against the
        // role's inbox prefix; this is belt-and-suspenders against future
        // pattern drift or shared streams.
        if (rec.type !== "write") return;
        const relPath = stripZonePrefix(rec.path);
        event = {
          event: "message_delivered",
          message_id: rec.event_id,
          sender: rec.agent_id ?? "",
          recipient: role,
          type: "event",
          path: relPath,
        };
      } else {
        return;
      }

      debugLog(
        "wsBridge.handleEvent",
        `role=${role} sender=${event.sender} path=${event.path} registeredSessions=[${[...this.sessions.keys()].join(",")}]`,
      );

      // Per-role dedupe: re-register aborts the old loop but cannot
      // force the in-flight dispatch to unwind before the new loop
      // comes online. Both loops can see the same Nexus message_id in
      // the handoff window — without this guard the runtime would
      // receive the same prompt twice.
      if (event.message_id) {
        let seen = this.recentMessageIds.get(role);
        if (!seen) {
          seen = new Set<string>();
          this.recentMessageIds.set(role, seen);
        }
        if (seen.has(event.message_id)) {
          debugLog("wsBridge.handleEvent", `DEDUPE role=${role} message_id=${event.message_id}`);
          return;
        }
        seen.add(event.message_id);
        if (seen.size > NexusWsBridge.RECENT_CAP) {
          const first = seen.values().next().value;
          if (first !== undefined) seen.delete(first);
        }
      }

      const session = this.sessions.get(role);
      if (!session) {
        debugLog("wsBridge.handleEvent", `NO SESSION for role=${role} — cannot deliver`);
        return;
      }

      // Rsync workspace files before delivering — the callback syncs source→target workspace
      try {
        this.opts.onBeforeDeliver?.(event.sender, role);
      } catch {
        /* non-fatal */
      }
      void this.readAndPush(event.path, role, session, event.sender, event.message_id);
    } catch {
      // Skip malformed events
    }
  }

  /**
   * Resolve which handoff record this IPC message correlates to, without
   * changing its state. Correlation is DETERMINISTIC — no time-based or
   * "most recent" heuristics, which could race and bind to a neighbouring
   * handoff under concurrent delivery.
   *
   * Match order:
   *   1. Exact ipcMessageId linkage (set by contribute.ts after IPC send).
   *   2. Composite key (toRole, fromRole, sourceCid) — sourceCid is the
   *      unique contribution ID attached to every handoff at creation,
   *      so this is a bijection. Used before setIpcMessageId() has landed.
   *
   * Best-effort — returns undefined on any store error or miss. Callers
   * must handle `undefined` (dead-letter deferral, retry).
   */
  private async resolveHandoffIdForMessage(
    ipcMessageId: string,
    targetRole: string,
    sender: string | undefined,
    sourceCid: string | undefined,
  ): Promise<string | undefined> {
    try {
      const store = this.opts.handoffStore;
      if (!store) return undefined;

      const handoffs = await store.list({ toRole: targetRole });

      // Primary: exact correlation via linked ipcMessageId.
      const byIpc = handoffs.find((h) => h.ipcMessageId === ipcMessageId);
      if (byIpc) return byIpc.handoffId;

      // Secondary: deterministic composite key with STATUS and
      // UNIQUENESS constraints. Contributions carry a unique sourceCid,
      // but multi-session Nexus deployments could theoretically share
      // a (fromRole, toRole, sourceCid) across sessions. Defense in
      // depth: restrict to unresolved statuses (pending_pickup /
      // delivered), then require EXACTLY ONE candidate. If multiple
      // survive the filter, the fallback is ambiguous — refuse to
      // mutate rather than risk cross-session corruption. The
      // ipcMessageId primary path and the deferred-drain retry loop
      // will succeed once the linkage lands, so returning undefined
      // here is recoverable.
      if (sender && sourceCid) {
        const candidates = handoffs.filter(
          (h) =>
            h.fromRole === sender &&
            h.sourceCid === sourceCid &&
            (h.status === "pending_pickup" || h.status === "delivered"),
        );
        if (candidates.length === 1) {
          return candidates[0]?.handoffId;
        }
        if (candidates.length > 1) {
          debugLog(
            "wsBridge.resolveHandoffIdForMessage",
            `AMBIGUOUS FALLBACK ipcMessageId=${ipcMessageId} role=${targetRole} cid=${sourceCid} candidates=${candidates.length} — deferring`,
          );
          return undefined;
        }
      }

      debugLog(
        "wsBridge.resolveHandoffIdForMessage",
        `NO MATCH ipcMessageId=${ipcMessageId} role=${targetRole} cid=${sourceCid ?? "none"} handoffCount=${handoffs.length}`,
      );
      return undefined;
    } catch (err) {
      debugLog(
        "wsBridge.resolveHandoffIdForMessage",
        `FAIL ipcMessageId=${ipcMessageId} err=${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * Mark a specific handoffId as delivered. Called after local push
   * succeeds. Best-effort — handoff store errors don't break delivery.
   */
  private async markHandoffDeliveredById(handoffId: string, targetRole: string): Promise<void> {
    try {
      const store = this.opts.handoffStore;
      if (!store) return;
      await store.markDelivered(handoffId);
      debugLog(
        "wsBridge.markHandoffDeliveredById",
        `DELIVERED handoffId=${handoffId} role=${targetRole}`,
      );
      const cacheable = store as { invalidateCache?: () => void };
      cacheable.invalidateCache?.();
    } catch (err) {
      debugLog(
        "wsBridge.markHandoffDeliveredById",
        `FAIL handoffId=${handoffId} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Dispatch a parsed inbox payload. Returns `"acp"` when the envelope was a
   * typed acp.* event handled (or gated) here, and thus should NOT be
   * forwarded to runtime.send; returns `"ipc"` when the envelope is a regular
   * IPC notification the caller should continue delivering to the agent.
   *
   * NexusEventBus.publish sends ONLY `event.payload` over the IPC wire — the
   * outer GroveEvent fields (sourceRole, targetRole, timestamp) are dropped.
   * We reconstruct a full GroveEvent here using the IPC-level sender/recipient
   * so the sink contract (which expects the full envelope) still holds.
   *
   * Public so unit tests can drive the branch without crafting SSE fixtures.
   */
  handleIpcEnvelope(
    innerPayload: unknown,
    wireSender?: string,
    wireRecipient?: string,
  ): "acp" | "ipc" {
    if (!innerPayload || typeof innerPayload !== "object") return "ipc";
    const rec = innerPayload as Record<string, unknown>;
    let type = rec.type;
    // Backward-compat: an older publisher that predates the `type`
    // embedding (Round 1 of #314) may send payloads without it. Fall back
    // to shape detection — sessionId + turnId + (message|result) is the
    // ACP envelope signature. This keeps rolling upgrades from routing
    // typed control events into an agent's prose IPC inbox.
    if (type !== "acp.message" && type !== "acp.result") {
      if (typeof rec.sessionId === "string" && typeof rec.turnId === "string") {
        if (rec.message !== undefined && typeof rec.message === "object") {
          type = "acp.message";
        } else if (rec.result !== undefined && typeof rec.result === "object") {
          type = "acp.result";
        }
      }
    }
    if (type !== "acp.message" && type !== "acp.result") return "ipc";

    const sourceRole = wireSender ?? "unknown";
    const targetRole = wireRecipient ?? "unknown";
    const envelope: GroveEvent = {
      type: type as "acp.message" | "acp.result",
      sourceRole,
      targetRole,
      payload: innerPayload as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    };

    const localRoles = new Set(this.opts.topology.roles.map((r) => r.name));
    const envelopeInstance = (rec as { sourceInstance?: unknown }).sourceInstance;
    if (localRoles.has(sourceRole)) {
      // Local role ⇒ the in-process EventBus subscription is already
      // ingesting this event. The SSE loopback is redundant. Forwarding
      // here would append the message frame a second time (the store has
      // no idempotency key; every `acp.message` pushes to the array).
      //
      // Bridge always carries `localInstanceId` (defaulted to the
      // process-wide id), and the publisher always stamps
      // `sourceInstance` (same default). Both sides carry markers in
      // every in-codebase publish, so strict inequality is the ONLY
      // condition for forwarding a local-role envelope. Any
      // legacy-publisher envelope without a marker is treated as a
      // self-loop and dropped — that's the deliberate trade-off for
      // "never duplicate in single-process".
      if (typeof envelopeInstance === "string" && envelopeInstance !== this.localInstanceId) {
        // Different instance with same role name — forward to sink.
      } else {
        return "acp";
      }
    }
    if (!this.opts.onAcpEvent) {
      // Fail-loud: a typed ACP envelope arrived but no consumer is wired.
      // Still return "acp" so readAndPush does not deliver control-plane
      // events as prose IPC to an agent inbox — log so operators can see
      // the silent drop happening instead of it being a true black hole.
      debugLog(
        "wsBridge.handleIpcEnvelope",
        `ACP envelope dropped — no onAcpEvent wired (type=${String(type)} sourceRole=${sourceRole})`,
      );
      return "acp";
    }
    try {
      this.opts.onAcpEvent(envelope);
    } catch (err) {
      debugLog(
        "wsBridge.handleIpcEnvelope",
        `onAcpEvent threw for sourceRole=${sourceRole}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return "acp";
  }

  /**
   * Dead-letter a handoff when local agent push fails after the Nexus
   * inbox already acknowledged delivery. Keeps the data-integrity story
   * from leaving a permanent false-positive "delivered" state when the
   * target agent never actually received the prompt.
   *
   * Full remediation (splitting the `delivered` state into
   * `inbox_delivered` vs `agent_received`) is out of scope for the
   * turn-typing migration and tracked as a follow-up.
   */
  private async markHandoffDeadLettered(
    handoffId: string | undefined,
    targetRole: string,
    reason: string,
    retryContext?: {
      ipcMessageId: string;
      sender: string | undefined;
      sourceCid: string | undefined;
    },
  ): Promise<void> {
    try {
      const store = this.opts.handoffStore;
      if (!store) return;

      // If correlation was temporarily unavailable at dispatch time
      // (setIpcMessageId fire-and-forget hadn't landed yet), retry
      // re-resolve with bounded backoff. Without this, a real
      // runtime.send failure + missed correlation would silently leave
      // the handoff in a stale `delivered` state, invisible to recovery
      // tooling.
      let effectiveId = handoffId;
      if (!effectiveId && retryContext) {
        const backoffs = [200, 500, 1000];
        for (const delay of backoffs) {
          await new Promise((r) => setTimeout(r, delay));
          effectiveId = await this.resolveHandoffIdForMessage(
            retryContext.ipcMessageId,
            targetRole,
            retryContext.sender,
            retryContext.sourceCid,
          );
          if (effectiveId) break;
        }
      }

      if (!effectiveId) {
        // Enqueue for deferred reconciliation. A background drain
        // (pendingDlqTimer) re-attempts resolution on the interval; if
        // the linkage eventually lands (typical outcome), the correct
        // handoff will be dead-lettered. Queue is bounded; close()
        // emits a loud stderr log for anything still pending.
        if (retryContext && !this.closed) {
          this.enqueuePendingDeadLetter(retryContext, targetRole, reason);
        } else {
          process.stderr.write(
            `[NexusWsBridge] CANNOT DEAD-LETTER role=${targetRole} reason=${reason}: correlation unresolved and no retry context available\n`,
          );
        }
        return;
      }

      await store.markDeadLettered(effectiveId);
      process.stderr.write(
        `[NexusWsBridge] dead-lettered handoffId=${effectiveId} role=${targetRole}: ${reason}\n`,
      );

      const cacheable = store as { invalidateCache?: () => void };
      cacheable.invalidateCache?.();
    } catch (err) {
      debugLog(
        "wsBridge.markHandoffDeadLettered",
        `FAIL handoffId=${handoffId} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private enqueuePendingDeadLetter(
    retryContext: {
      ipcMessageId: string;
      sender: string | undefined;
      sourceCid: string | undefined;
    },
    targetRole: string,
    reason: string,
  ): void {
    // Refuse new enqueues only after close() — the drain-until-no-
    // progress loop in flushPendingDeadLettersThenLog is robust against
    // late enqueues during draining (it terminates when a pass makes
    // no progress, not when size is stable), so entries appended
    // while draining still get a fair drain attempt before shutdown
    // clears them. After closed=true, no drain will run, so reject
    // loudly.
    if (this.closed) {
      process.stderr.write(
        `[NexusWsBridge] DROPPED pending dead-letter (bridge closed) ipcMessageId=${retryContext.ipcMessageId} role=${targetRole}: ${reason}\n`,
      );
      return;
    }
    // De-dupe by ipcMessageId — a repeat failure for the same message
    // must not inflate the queue.
    const existing = this.pendingDeadLetters.find(
      (e) => e.ipcMessageId === retryContext.ipcMessageId,
    );
    if (existing) return;
    if (this.pendingDeadLetters.length >= NexusWsBridge.PENDING_DLQ_CAP) {
      // Drop oldest (FIFO) under sustained backpressure, but log loudly
      // so operators see queue saturation instead of silent eviction.
      const dropped = this.pendingDeadLetters.shift();
      if (dropped) {
        process.stderr.write(
          `[NexusWsBridge] DROPPED pending dead-letter (queue full) ipcMessageId=${dropped.ipcMessageId} role=${dropped.targetRole}: ${dropped.reason}\n`,
        );
      }
    }
    this.pendingDeadLetters.push({
      ipcMessageId: retryContext.ipcMessageId,
      targetRole,
      sender: retryContext.sender,
      sourceCid: retryContext.sourceCid,
      reason,
      attempts: 0,
      lastAttemptAt: Date.now(),
    });
    process.stderr.write(
      `[NexusWsBridge] queued pending dead-letter role=${targetRole} ipcMessageId=${retryContext.ipcMessageId}: ${reason} (queueSize=${this.pendingDeadLetters.length})\n`,
    );
  }

  /**
   * Two-phase teardown with bounded final drain. Callers that need
   * maximum recovery-state preservation (process-exit shutdown path)
   * should await this instead of the fire-and-forget `close()`.
   *
   * Phase 1: Enter `draining` — stop accepting new pending dead-letters
   *          and abort SSE loops so no more entries can be enqueued.
   * Phase 2: Await a bounded final drain loop until the queue is stable
   *          (or the overall deadline expires).
   * Phase 3: Close (sync) to release remaining resources.
   */
  async shutdown(shutdownTimeoutMs = 10000): Promise<void> {
    if (this.closed) return;
    // Single-flight: concurrent shutdown() callers must await the same
    // teardown rather than racing. Without this latch, two callers can
    // enter the drain/close sequence simultaneously, the second one's
    // close() clearing the queue before the first's drain completes.
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }
    this.shutdownPromise = this.doShutdown(shutdownTimeoutMs);
    try {
      await this.shutdownPromise;
    } finally {
      this.shutdownPromise = null;
    }
  }

  private async doShutdown(shutdownTimeoutMs: number): Promise<void> {
    const overallDeadline = Date.now() + shutdownTimeoutMs;
    if (this.pendingDlqTimer !== null) {
      clearInterval(this.pendingDlqTimer);
      this.pendingDlqTimer = null;
    }
    // Quiesce ingress BEFORE flushing: set draining to block new
    // SSE-driven sends, then abort SSE/read loops so in-flight
    // readAndPush cannot start new sends during the await below.
    // In-flight readAndPush that already passed the draining guard
    // will still dispatch runtime.send, and those sends need to
    // complete before we final-drain.
    this.draining = true;
    for (const ac of this.abortControllers) ac.abort();
    this.abortControllers.clear();
    for (const ac of this.roleAborts.values()) ac.abort();
    this.roleAborts.clear();

    // Interleave: wait for in-flight sends and drain the queue in
    // alternating passes until both are empty or deadline exhausts.
    // Each pass: (1) wait briefly for any in-flight sends so late
    // failures can enqueue, (2) drain the queue. This catches entries
    // that enqueue between passes, which a single wait-then-drain
    // sequence would miss.
    while (Date.now() < overallDeadline) {
      if (this.inFlightSends.size === 0 && this.pendingDeadLetters.length === 0) break;
      const perPassBudget = Math.min(500, Math.max(0, overallDeadline - Date.now()));
      if (perPassBudget === 0) break;
      if (this.inFlightSends.size > 0) {
        const timer = new Promise<void>((resolve) => setTimeout(resolve, perPassBudget));
        await Promise.race([
          Promise.allSettled([...this.inFlightSends]).then(() => {
            /* settled */
          }),
          timer,
        ]);
      }
      if (this.pendingDeadLetters.length > 0) {
        const remaining = Math.max(0, overallDeadline - Date.now());
        if (remaining === 0) break;
        await this.flushPendingDeadLettersThenLog(remaining);
      }
    }
    if (this.inFlightSends.size > 0) {
      process.stderr.write(
        `[NexusWsBridge] shutdown deadline reached with ${this.inFlightSends.size} in-flight send(s) unresolved\n`,
      );
    }
    if (this.pendingDeadLetters.length > 0) {
      // flushPendingDeadLettersThenLog logs unresolved + clears. If we
      // reach here without it running (e.g. deadline exhausted before
      // flush was called), still log + clear so shutdown's guarantee
      // holds: no queue survives shutdown.
      for (const entry of this.pendingDeadLetters) {
        process.stderr.write(
          `[NexusWsBridge] UNRESOLVED dead-letter on close role=${entry.targetRole} ipcMessageId=${entry.ipcMessageId} attempts=${entry.attempts}: ${entry.reason}\n`,
        );
      }
      this.pendingDeadLetters = [];
    }
    this.close();
  }

  private async flushPendingDeadLettersThenLog(deadlineMs: number): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    // Bounded wait for any in-flight drain to settle. Prevents an
    // indefinite hang if a background drain is stuck on slow I/O.
    while (this.pendingDlqDrainInFlight) {
      if (Date.now() >= deadline) {
        process.stderr.write(
          `[NexusWsBridge] shutdown flush timed out waiting for in-flight drain; falling through\n`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const store = this.opts.handoffStore;
    if (store) {
      // Drain until deadline OR queue empty. Keep retrying even when a
      // pass makes no progress — IPC→handoff linkage (setIpcMessageId
      // in contribute.ts is fire-and-forget) can land between passes,
      // so a short backoff plus retry catches entries that would
      // otherwise be permanently stale. Only a bounded total deadline
      // stops the loop; within it, unresolved entries get repeated
      // reconciliation attempts.
      const backoffMs = 250;
      while (Date.now() < deadline && this.pendingDeadLetters.length > 0) {
        this.pendingDlqDrainInFlight = true;
        try {
          // countAttempts=false: shutdown's 250ms cadence is far more
          // aggressive than the 30s background cadence. Counting each
          // retry against PENDING_DLQ_MAX_ATTEMPTS (20) would exhaust
          // the budget in ~5s and drop recoverable entries. The total
          // time budget is the only bound during shutdown flush.
          await this.doDrainPendingDeadLetters(store, false);
        } finally {
          this.pendingDlqDrainInFlight = false;
        }
        if (this.pendingDeadLetters.length === 0) break;
        const sleepUntil = Math.min(Date.now() + backoffMs, deadline);
        const sleepFor = sleepUntil - Date.now();
        if (sleepFor <= 0) break;
        await new Promise((r) => setTimeout(r, sleepFor));
      }
    }
    for (const entry of this.pendingDeadLetters) {
      process.stderr.write(
        `[NexusWsBridge] UNRESOLVED dead-letter on close role=${entry.targetRole} ipcMessageId=${entry.ipcMessageId} attempts=${entry.attempts}: ${entry.reason}\n`,
      );
    }
    this.pendingDeadLetters = [];
  }

  private async drainPendingDeadLetters(): Promise<void> {
    if (this.closed || this.pendingDeadLetters.length === 0) return;
    const store = this.opts.handoffStore;
    if (!store) return;

    // Single-flight guard. A drain run longer than the timer interval
    // (slow store.list, large queue) would otherwise overlap and share
    // entry objects across runs — attempts would double-increment and
    // entries could be removed before correlation resolves.
    if (this.pendingDlqDrainInFlight) return;
    this.pendingDlqDrainInFlight = true;
    try {
      await this.doDrainPendingDeadLetters(store);
    } finally {
      this.pendingDlqDrainInFlight = false;
    }
  }

  /**
   * Returns true if the pass resolved or exhausted any entries.
   * When `countAttempts` is false (shutdown fast-loop), entry.attempts
   * is NOT incremented — the 250ms retry cadence during shutdown is
   * far more aggressive than the 30s normal background cadence, and
   * counting each retry against the same attempt budget would exhaust
   * it in seconds. Attempts still stop at PENDING_DLQ_MAX_ATTEMPTS
   * when charged normally.
   */
  private async doDrainPendingDeadLetters(
    store: HandoffStore,
    countAttempts = true,
  ): Promise<boolean> {
    // Snapshot + iterate; mutations during async await are safe because
    // we filter the live list at the end rather than index in place.
    // Note: no `this.closed` short-circuit here — a close-time final
    // drain explicitly needs to run after closed=true, and the timer
    // callback that could re-enter here is cleared synchronously
    // before flushPendingDeadLettersThenLog so no concurrent invocation
    // can occur.
    const entries = [...this.pendingDeadLetters];
    const resolved = new Set<string>();
    const exhausted = new Set<string>();

    for (const entry of entries) {
      if (countAttempts) {
        entry.attempts += 1;
        entry.lastAttemptAt = Date.now();
      }

      const id = await this.resolveHandoffIdForMessage(
        entry.ipcMessageId,
        entry.targetRole,
        entry.sender,
        entry.sourceCid,
      );
      if (id) {
        try {
          await store.markDeadLettered(id);
          const cacheable = store as { invalidateCache?: () => void };
          cacheable.invalidateCache?.();
          process.stderr.write(
            `[NexusWsBridge] deferred dead-letter succeeded handoffId=${id} role=${entry.targetRole} attempts=${entry.attempts}: ${entry.reason}\n`,
          );
          resolved.add(entry.ipcMessageId);
        } catch (err) {
          // Terminal mark failures (invalid transition: the handoff is
          // already replied/expired/dead_lettered, or the handoff
          // doesn't exist) cannot be retried — they're not races.
          // Treat as exhausted so the entry ages out and cannot
          // occupy the queue forever. Store/IO errors remain retried
          // (kept in the queue for the next pass).
          const name = err instanceof Error ? err.name : "";
          const msg = err instanceof Error ? err.message : String(err);
          const terminal =
            name === "InvalidTransitionError" ||
            /not found|no such|missing|invalid transition/i.test(msg);
          if (terminal) {
            process.stderr.write(
              `[NexusWsBridge] terminal mark failure handoffId=${id} role=${entry.targetRole}: ${msg} — ageing out\n`,
            );
            exhausted.add(entry.ipcMessageId);
          } else {
            debugLog(
              "wsBridge.drainPendingDeadLetters",
              `RETRIABLE FAIL handoffId=${id} err=${msg}`,
            );
          }
        }
        continue;
      }
      if (countAttempts && entry.attempts >= NexusWsBridge.PENDING_DLQ_MAX_ATTEMPTS) {
        process.stderr.write(
          `[NexusWsBridge] GIVING UP pending dead-letter role=${entry.targetRole} ipcMessageId=${entry.ipcMessageId} after ${entry.attempts} attempts: ${entry.reason}\n`,
        );
        exhausted.add(entry.ipcMessageId);
      }
    }

    if (resolved.size === 0 && exhausted.size === 0) return false;
    this.pendingDeadLetters = this.pendingDeadLetters.filter(
      (e) => !resolved.has(e.ipcMessageId) && !exhausted.has(e.ipcMessageId),
    );
    return true;
  }

  private async readAndPush(
    path: string,
    _targetRole: string,
    session: AgentSession,
    sender: string,
    ipcMessageId?: string,
  ): Promise<void> {
    try {
      // Shutdown teardown guard: refuse to push or retry once shutdown
      // has begun. Without this, an in-flight read that completed
      // sys_read before SSE abort could still call runtime.send against
      // a torn-down session, AND a subsequent runtime.send failure
      // would enqueue a dead-letter that gets dropped by the
      // `draining` guard in enqueuePendingDeadLetter — so the real
      // failure is silently lost. Exit early.
      if (this.draining || this.closed) return;
      // Retry on 429 (rate limit) — the inbox read is critical for IPC delivery.
      let resp: Response | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        resp = await fetch(`${this.opts.nexusUrl}/api/nfs/sys_read`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "sys_read",
            params: { path },
            id: 1,
          }),
        });
        if (resp.status !== 429) break;
        // Backoff: 2s, 4s, 8s, 16s, 32s
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
      if (!resp || !resp.ok) {
        debugLog("wsBridge.readAndPush", `FAIL resp.status=${resp?.status ?? "none"} path=${path}`);
        // handleEvent already deduped message_id; redelivery will not repair
        // the cache. Emit a bounded invalidation so the next panel refresh
        // picks up any contribution that did make it into the VFS store.
        this.publishInvalidation(_targetRole, ipcMessageId);
        return;
      }

      const result = (await resp.json()) as { result?: { data?: string }; error?: unknown };
      if (!result.result?.data) {
        debugLog(
          "wsBridge.readAndPush",
          `NO DATA path=${path} error=${JSON.stringify(result.error ?? "none").slice(0, 100)}`,
        );
        this.publishInvalidation(_targetRole, ipcMessageId);
        return;
      }

      const raw = Buffer.from(result.result.data, "base64").toString();
      const msg = JSON.parse(raw) as {
        from?: string;
        sender?: string;
        payload?: Record<string, unknown>;
      };

      const msgSender = msg.from ?? msg.sender ?? sender;

      // Pre-dispatch: typed acp.* envelopes go to the typed consumer and
      // skip the runtime.send IPC-notification path. Pass wire-level
      // sender/recipient so the bridge can reconstruct the outer GroveEvent
      // shape (NexusEventBus sends only `event.payload` over the wire).
      const outcome = this.handleIpcEnvelope(msg.payload, msgSender, _targetRole);
      if (outcome === "acp") {
        return;
      }

      const payload = msg.payload ?? {};
      const cid = typeof payload.cid === "string" ? payload.cid : undefined;
      const kind = typeof payload.kind === "string" ? payload.kind : undefined;

      // Notify the TUI EventBus that a contribution was delivered, so
      // panels can invalidate their list cache and refetch. Gated on
      // (cid + kind) to skip non-contribution inbox traffic — otherwise
      // every ACP envelope (already filtered above) or generic IPC
      // notification would trigger a full VFS rescan.
      if (this.opts.eventBus && cid && kind) {
        const groveEvent: GroveEvent = {
          type: "contribution",
          sourceRole: msgSender,
          targetRole: _targetRole,
          payload: { message_id: ipcMessageId, cid, kind },
          timestamp: new Date().toISOString(),
        };
        void this.opts.eventBus.publish(groveEvent);
      }
      const summary =
        (payload.summary as string) ??
        (payload.body as string) ??
        JSON.stringify(payload).slice(0, 100);
      // When the payload carries a contribution envelope (cid + kind), include
      // the CID and a kind-specific action hint so the recipient can act without
      // a discovery round-trip (grove_log/grove_frontier — the "polling" pattern
      // push is supposed to eliminate). Action text is keyed by inbound kind:
      // a `work` contribution arriving at the reviewer → submit a review.
      // A `review` arriving at the coder → submit updated work. Unknown kinds
      // fall back to neutral guidance.
      const actionHint = ((): string => {
        switch (kind) {
          case "work":
            return "Respond with grove_submit_review to review this work.";
          case "review":
            return "Respond with grove_submit_work to submit updated work addressing this review.";
          case "plan":
          case "discussion":
            return "Respond with grove_send_message or grove_submit_work as appropriate.";
          default:
            return "Respond with the appropriate grove_* tool for this contribution.";
        }
      })();
      const notification =
        cid && kind
          ? `[grove] New ${kind} from ${msgSender}:\n  CID: ${cid}\n  Summary: ${summary}\n\n${actionHint}`
          : `[IPC from ${msgSender}] ${summary}`;
      debugLog(
        "wsBridge.readAndPush",
        `delivering to session=${session.id} role=${_targetRole} notification=${notification.slice(0, 80)}`,
      );

      // Session-identity re-check: handleEvent captured `session` at SSE
      // dispatch time, but the sys_read fetch + decode above are async.
      // If the role was unregistered or replaced during that window, the
      // captured session may now be closed. Push to a dead session would
      // fail and — worse — trigger dead-lettering for a handoff that a
      // replacement session should still receive. Skip delivery and skip
      // dead-lettering in that case; the replacement's own SSE loop will
      // pick up the redelivery from Nexus.
      const current = this.sessions.get(_targetRole);
      if (!current || current.id !== session.id) {
        debugLog(
          "wsBridge.readAndPush",
          `SKIP stale session for role=${_targetRole} captured=${session.id} current=${current?.id ?? "none"}`,
        );
        return;
      }

      // Capture the correlated handoffId NOW using DETERMINISTIC keys
      // (exact ipcMessageId → (fromRole, sourceCid) composite). Both the
      // success path (markDelivered) and the failure path (markDeadLettered)
      // operate on this id so they cannot race each other or be defeated
      // by a fire-and-forget setIpcMessageId() that lands after this
      // point. Mark delivered only AFTER runtime.send succeeds — a
      // premature `delivered` before the turn completes creates
      // irreversible skew if the turn fails (handoff stuck `delivered`,
      // recovery tooling blind to the gap). On failure with missing
      // correlation, markHandoffDeadLettered re-resolves with backoff
      // so the linkage race cannot silently swallow a real failure.
      const resolvedHandoffId =
        this.opts.handoffStore && ipcMessageId
          ? await this.resolveHandoffIdForMessage(ipcMessageId, _targetRole, msgSender, cid)
          : undefined;
      const retryContext = ipcMessageId
        ? { ipcMessageId, sender: msgSender, sourceCid: cid }
        : undefined;

      // Second teardown guard: the resolveHandoffIdForMessage await
      // above can run during shutdown between the entry guard and
      // runtime.send. Re-check before actually dispatching so a
      // racing shutdown() aborts this path cleanly instead of pushing
      // to a torn-down runtime.
      if (this.draining || this.closed) return;

      const sendPromise = this.opts.runtime
        .send(session, notification)
        .then(async (turn) => {
          const result = await turn.result.catch((err) => ({
            turnId: turn.turnId,
            stopReason: "error" as const,
            error: {
              code: "turn_rejected",
              message: err instanceof Error ? err.message : String(err),
            },
          }));
          // For control-plane delivery, `end_turn` is the only success
          // signal. Treat cancelled / max_tokens / error / unknown stop
          // reasons all as delivery failures so the handoff is dead-
          // lettered — matches watchTurnError's abnormal-terminal policy.
          if (result.stopReason === "end_turn") {
            if (resolvedHandoffId) {
              await this.markHandoffDeliveredById(resolvedHandoffId, _targetRole);
            }
          } else {
            const detail = result.error
              ? `${result.error.code}: ${result.error.message}`
              : `stopReason=${result.stopReason}`;
            process.stderr.write(
              `[NexusWsBridge] local push failed for role=${_targetRole} turn=${turn.turnId}: ${detail}\n`,
            );
            await this.markHandoffDeadLettered(
              resolvedHandoffId,
              _targetRole,
              `local push abnormal: ${detail}`,
              retryContext,
            );
          }
        })
        .catch(async (err) => {
          const detail = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[NexusWsBridge] runtime.send rejected for role=${_targetRole}: ${detail}\n`,
          );
          await this.markHandoffDeadLettered(
            resolvedHandoffId,
            _targetRole,
            `runtime.send rejected: ${detail}`,
            retryContext,
          );
        });

      // Track the send-and-status-update promise so shutdown() can
      // await it (bounded) before the final drain. Without this, a
      // late failure could try to enqueue after closed=true and get
      // dropped. Removal happens in finally so successes and failures
      // both get cleaned up.
      const tracked = sendPromise.finally(() => {
        this.inFlightSends.delete(tracked);
      });
      this.inFlightSends.add(tracked);
    } catch {
      // Non-fatal — emit invalidation so transient parse/network failures
      // don't permanently silence the cache-refresh path for this delivery.
      this.publishInvalidation(_targetRole, ipcMessageId);
    }
  }

  /**
   * Emit a "contribution invalidation" event for failure paths in
   * readAndPush. handleEvent registers `message_id` in `recentMessageIds`
   * before this method runs, so a failed sys_read / parse leaves the
   * delivery permanently deduped — without a subsequent invalidation
   * signal, TUI panels would not drop their list-cache and would keep
   * showing stale data until the next 30 s poll. Payload omits cid/kind
   * because the read failed; the subscriber treats it as "refetch now".
   */
  private publishInvalidation(targetRole: string, ipcMessageId?: string): void {
    if (!this.opts.eventBus) return;
    const groveEvent: GroveEvent = {
      type: "contribution",
      sourceRole: "system",
      targetRole,
      payload: { message_id: ipcMessageId, invalidation: true },
      timestamp: new Date().toISOString(),
    };
    void this.opts.eventBus.publish(groveEvent);
  }
}
