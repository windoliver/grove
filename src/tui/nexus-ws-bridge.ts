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
  private readonly sessions = new Map<string, AgentSession>();
  private abortControllers: AbortController[] = [];
  private closed = false;

  constructor(opts: NexusWsBridgeOptions) {
    this.opts = opts;
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

  /** Provision agents and connect SSE streams for all topology roles. */
  connect(): void {
    if (this.closed) return;
    void this.provisionAgents();
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
  private async provisionAgents(): Promise<void> {
    for (const role of this.opts.topology.roles) {
      try {
        await fetch(`${this.opts.nexusUrl}/api/v2/agents/register`, {
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
        });
      } catch {
        // Best-effort — agent may already be registered
      }
    }
  }

  private async startSseForRole(role: string): Promise<void> {
    while (!this.closed) {
      try {
        await this.connectSse(role);
      } catch {
        // Reconnect after delay
      }
      if (!this.closed) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async connectSse(role: string): Promise<void> {
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

    if (!resp.ok || !resp.body) return;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!this.closed) {
      const { done, value } = await reader.read();
      if (done) break;

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

      // --- IPC lifecycle: mark matching handoff as delivered ---
      // The message_delivered SSE confirms Nexus inbox delivery.
      // Find the handoff by IPC message ID and transition its status.
      if (this.opts.handoffStore && event.message_id) {
        void this.updateHandoffDeliveryStatus(event.message_id, role, event.sender);
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
   * Public so unit tests can drive the branch without crafting SSE fixtures.
   */
  handleIpcEnvelope(innerPayload: unknown): "acp" | "ipc" {
    if (!innerPayload || typeof innerPayload !== "object") return "ipc";
    const type = (innerPayload as { type?: unknown }).type;
    if (type !== "acp.message" && type !== "acp.result") return "ipc";

    const envelope = innerPayload as GroveEvent;
    const localRoles = new Set(this.opts.topology.roles.map((r) => r.name));
    if (localRoles.has(envelope.sourceRole)) {
      // Local role — the in-process NexusEventBus subscription will ingest
      // this event; skipping forward avoids double-counting.
      return "acp";
    }
    this.opts.onAcpEvent?.(envelope);
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

      // Pre-dispatch: typed acp.* envelopes go to the typed consumer and
      // skip the runtime.send IPC-notification path.
      const outcome = this.handleIpcEnvelope(msg.payload);
      if (outcome === "acp") {
        return;
      }

      const msgSender = msg.from ?? msg.sender ?? sender;
      const summary =
        (msg.payload?.summary as string) ??
        (msg.payload?.body as string) ??
        JSON.stringify(msg.payload ?? {}).slice(0, 100);
      const notification = `[IPC from ${msgSender}] ${summary}`;
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
