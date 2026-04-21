/**
 * Nexus IPC bridge — real-time push via Nexus SSE + IPC API (v0.9.14+).
 *
 * Endpoints used:
 *   POST /api/v2/ipc/send              — send message to agent inbox
 *   GET  /api/v2/ipc/stream/{agent_id} — SSE stream for inbox notifications
 *   POST /api/v2/agents/register       — provision agent (creates inbox)
 *
 * Flow: SSE delivers message_delivered events → reads message via VFS →
 * pushes to target agent via runtime.send().
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

export class NexusWsBridge {
  private readonly opts: NexusWsBridgeOptions;
  private readonly localInstanceId: string;
  private readonly sessions = new Map<string, AgentSession>();
  private abortControllers: AbortController[] = [];
  private closed = false;

  constructor(opts: NexusWsBridgeOptions) {
    this.opts = opts;
    // Default to the process-wide id so the bridge always carries a marker,
    // matching the publisher's default. This closes the "legacy publisher
    // without marker" blind spot in strict-dedupe mode — every in-process
    // event carries the same id on both sides, cross-process events
    // necessarily differ, and pure role-name fallback is only active in
    // tests that explicitly opt out by constructing with no localInstanceId.
    this.localInstanceId = opts.localInstanceId ?? getProcessInstanceId();
  }

  registerSession(role: string, session: AgentSession): void {
    this.sessions.set(role, session);
    if (!this.closed) {
      void this.startSseForRole(role);
    }
  }

  unregisterSession(role: string): void {
    this.sessions.delete(role);
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
          const resp = await fetch(
            `${this.opts.nexusUrl}/api/v2/ipc/stream/${encodeURIComponent(role.name)}`,
            {
              headers: {
                Authorization: `Bearer ${this.opts.apiKey}`,
                Accept: "text/event-stream",
              },
              signal: ac.signal,
            },
          );
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
    this.closed = true;
    for (const ac of this.abortControllers) {
      ac.abort();
    }
    this.abortControllers = [];
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
    // Fallback: direct fetch (backward compat when ipcClient not injected)
    try {
      const resp = await fetch(`${this.opts.nexusUrl}/api/v2/ipc/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({ sender, recipient, type: "event", payload }),
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

  private async startSseForRole(role: string): Promise<void> {
    let consecutiveFailures = 0;
    const threshold = this.opts.unhealthyThreshold ?? 3;
    let firedUnhealthy = false;
    while (!this.closed) {
      let streamOk = false;
      try {
        streamOk = await this.connectSse(role);
      } catch {
        streamOk = false;
      }
      if (streamOk) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        if (consecutiveFailures >= threshold && !firedUnhealthy) {
          firedUnhealthy = true;
          try {
            this.opts.onRoleUnhealthy?.(role, consecutiveFailures);
          } catch {
            // callback errors shouldn't kill the reconnect loop
          }
        }
      }
      if (!this.closed) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  /**
   * Open an SSE stream for the role. Returns true when the stream
   * upgraded successfully (2xx + body) and at least one read cycle ran,
   * false when the server refused/rejected the stream. Used by
   * startSseForRole to distinguish a real stream cycle from a failed
   * open for health tracking.
   */
  private async connectSse(role: string): Promise<boolean> {
    const ac = new AbortController();
    this.abortControllers.push(ac);
    const url = `${this.opts.nexusUrl}/api/v2/ipc/stream/${encodeURIComponent(role)}`;

    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        Accept: "text/event-stream",
      },
      signal: ac.signal,
    });

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
    // (": ping\n") or nothing at all. Count the cycle healthy the
    // moment the reader yields any bytes — that proves the TCP pipe
    // is flowing. An immediate EOF (done=true on the first read
    // without prior bytes) still returns false, which is the one
    // case the unhealthy counter needs to catch.
    let sawBytes = false;

    while (!this.closed) {
      const { done, value } = await reader.read();
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
          this.handleEvent(role, eventType, eventData);
          eventType = null;
          eventData = null;
        }
      }
    }
    return sawBytes;
  }

  private handleEvent(role: string, eventType: string | null, raw: string): void {
    try {
      if (eventType !== "message_delivered") return;

      const event = JSON.parse(raw) as SseEvent;
      debugLog(
        "wsBridge.handleEvent",
        `role=${role} sender=${event.sender} path=${event.path} registeredSessions=[${[...this.sessions.keys()].join(",")}]`,
      );

      // Notify the TUI EventBus — triggers contribution feed refresh (no polling needed)
      if (this.opts.eventBus) {
        const groveEvent: GroveEvent = {
          type: "contribution",
          sourceRole: event.sender,
          targetRole: role,
          payload: { message_id: event.message_id },
          timestamp: new Date().toISOString(),
        };
        void this.opts.eventBus.publish(groveEvent);
      }

      // Handoff delivery-status transitions are deferred until after
      // ACP classification in readAndPush. ACP envelopes (high-volume,
      // never backed by a handoff record) would otherwise trigger the
      // sender-based fallback in updateHandoffDeliveryStatus and
      // falsely mark an unrelated pending handoff as delivered.

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
   * Update handoff delivery status when an IPC message_delivered SSE event arrives.
   *
   * Correlates by ipcMessageId first, then falls back to matching by
   * (toRole, status=pending_pickup) for the most recent undelivered handoff.
   * The fallback handles the race where message_delivered arrives before
   * the fire-and-forget setIpcMessageId() in contribute.ts completes.
   *
   * Best-effort — handoff store errors don't block delivery.
   */
  private async updateHandoffDeliveryStatus(
    ipcMessageId: string,
    targetRole: string,
    sender?: string,
  ): Promise<void> {
    try {
      const store = this.opts.handoffStore;
      if (!store) return;

      const handoffs = await store.list({ toRole: targetRole });

      // Primary: match by IPC message ID (exact correlation)
      let matching = handoffs.find((h) => h.ipcMessageId === ipcMessageId);

      // Fallback: match most recent pending handoff for this role FROM the
      // same sender. Constrains by sender to avoid cross-matching handoffs
      // from different source roles. The SSE event carries the sender field.
      if (!matching && sender) {
        matching = handoffs
          .filter(
            (h) =>
              h.fromRole === sender &&
              (h.status === "pending_pickup" || h.status === "delivered") &&
              !h.ipcMessageId, // only match handoffs that haven't been IPC-linked yet
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      }

      if (matching) {
        await store.markDelivered(matching.handoffId);
        debugLog(
          "wsBridge.updateHandoffDeliveryStatus",
          `DELIVERED handoffId=${matching.handoffId} ipcMessageId=${ipcMessageId} role=${targetRole}`,
        );

        // Invalidate cache if the store supports it (NexusHandoffStore)
        const cacheable = store as { invalidateCache?: () => void };
        cacheable.invalidateCache?.();
      } else {
        debugLog(
          "wsBridge.updateHandoffDeliveryStatus",
          `NO MATCH ipcMessageId=${ipcMessageId} role=${targetRole} handoffCount=${handoffs.length}`,
        );
      }
    } catch (err) {
      debugLog(
        "wsBridge.updateHandoffDeliveryStatus",
        `FAIL ipcMessageId=${ipcMessageId} err=${err instanceof Error ? err.message : String(err)}`,
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
    ipcMessageId: string | undefined,
    targetRole: string,
    _sender: string | undefined,
    reason: string,
  ): Promise<void> {
    try {
      const store = this.opts.handoffStore;
      if (!store || !ipcMessageId) return;

      // Require exact `ipcMessageId` correlation. Dead-letter is a terminal
      // state, so the sender-based fallback that updateHandoffDeliveryStatus
      // uses for marking delivered is too loose here: if ipcMessageId is not
      // yet linked to any handoff, the "most recent from sender" heuristic
      // could terminally dead-letter a neighbouring handoff while the real
      // failure quietly stays `delivered`. Prefer deferring — another pass
      // after setIpcMessageId() lands can still dead-letter correctly.
      const handoffs = await store.list({ toRole: targetRole });
      const matching = handoffs.find((h) => h.ipcMessageId === ipcMessageId);
      if (!matching) {
        debugLog(
          "wsBridge.markHandoffDeadLettered",
          `NO EXACT MATCH ipcMessageId=${ipcMessageId} role=${targetRole} — deferring`,
        );
        return;
      }

      await store.markDeadLettered(matching.handoffId);
      process.stderr.write(
        `[NexusWsBridge] dead-lettered handoffId=${matching.handoffId} role=${targetRole}: ${reason}\n`,
      );

      const cacheable = store as { invalidateCache?: () => void };
      cacheable.invalidateCache?.();
    } catch (err) {
      debugLog(
        "wsBridge.markHandoffDeadLettered",
        `FAIL ipcMessageId=${ipcMessageId} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async readAndPush(
    path: string,
    _targetRole: string,
    session: AgentSession,
    sender: string,
    ipcMessageId?: string,
  ): Promise<void> {
    try {
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
        return;
      }

      const result = (await resp.json()) as { result?: { data?: string }; error?: unknown };
      if (!result.result?.data) {
        debugLog(
          "wsBridge.readAndPush",
          `NO DATA path=${path} error=${JSON.stringify(result.error ?? "none").slice(0, 100)}`,
        );
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

      // Non-ACP prose IPC: this is a real handoff notification, so now
      // advance the handoff's delivery state. Running this AFTER the ACP
      // check prevents ACP envelopes (never backed by a handoff record)
      // from triggering updateHandoffDeliveryStatus's sender-fallback
      // and falsely marking an unrelated pending handoff as delivered.
      if (this.opts.handoffStore && ipcMessageId) {
        void this.updateHandoffDeliveryStatus(ipcMessageId, _targetRole, msgSender);
      }

      const payload = msg.payload ?? {};
      const cid = typeof payload.cid === "string" ? payload.cid : undefined;
      const kind = typeof payload.kind === "string" ? payload.kind : undefined;
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

      // The handoff has already been marked `delivered` upstream on the
      // Nexus inbox SSE. Full separation of "inbox delivered" vs "agent
      // received" is out of scope for the turn-typing migration — but when
      // the local push below actually fails, we at least move the handoff
      // to the dead-letter state so recovery tooling can see it instead
      // of treating the stale "delivered" record as the final truth.
      void this.opts.runtime
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
          if (result.stopReason !== "end_turn") {
            const detail = result.error
              ? `${result.error.code}: ${result.error.message}`
              : `stopReason=${result.stopReason}`;
            process.stderr.write(
              `[NexusWsBridge] local push failed for role=${_targetRole} turn=${turn.turnId}: ${detail}\n`,
            );
            await this.markHandoffDeadLettered(
              ipcMessageId,
              _targetRole,
              sender,
              `local push abnormal: ${detail}`,
            );
          }
        })
        .catch(async (err) => {
          const detail = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[NexusWsBridge] runtime.send rejected for role=${_targetRole}: ${detail}\n`,
          );
          await this.markHandoffDeadLettered(
            ipcMessageId,
            _targetRole,
            sender,
            `runtime.send rejected: ${detail}`,
          );
        });
    } catch {
      // Non-fatal
    }
  }
}
