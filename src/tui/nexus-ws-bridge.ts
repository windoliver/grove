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
import type { AgentTopology } from "../core/topology.js";

export interface NexusWsBridgeOptions {
  topology: AgentTopology;
  runtime: AgentRuntime;
  nexusUrl: string;
  apiKey: string;
  /** EventBus to notify the TUI when SSE events arrive (triggers data refresh). */
  eventBus?: EventBus | undefined;
  /** Called before delivering IPC to an agent — use for workspace rsync. */
  onBeforeDeliver?: ((sender: string, recipient: string) => void) | undefined;
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
      try {
        const { appendFileSync } = require("node:fs") as typeof import("node:fs");
        appendFileSync(
          "/tmp/grove-debug.log",
          `[${new Date().toISOString()}] [wsBridge.handleEvent] role=${role} sender=${event.sender} path=${event.path} registeredSessions=[${[...this.sessions.keys()].join(",")}]\n`,
        );
      } catch {
        /* */
      }

      // Notify the TUI EventBus — triggers contribution feed refresh (no polling needed)
      if (this.opts.eventBus) {
        const groveEvent: GroveEvent = {
          type: "contribution",
          sourceRole: event.sender,
          targetRole: role,
          payload: { message_id: event.message_id },
          timestamp: new Date().toISOString(),
        };
        this.opts.eventBus.publish(groveEvent);
      }

      const session = this.sessions.get(role);
      if (!session) {
        try {
          const { appendFileSync } = require("node:fs") as typeof import("node:fs");
          appendFileSync(
            "/tmp/grove-debug.log",
            `[${new Date().toISOString()}] [wsBridge.handleEvent] NO SESSION for role=${role} — cannot deliver\n`,
          );
        } catch {
          /* */
        }
        return;
      }

      // Rsync workspace files before delivering — the callback syncs source→target workspace
      try {
        this.opts.onBeforeDeliver?.(event.sender, role);
      } catch {
        /* non-fatal */
      }
      void this.readAndPush(event.path, role, session, event.sender);
    } catch {
      // Skip malformed events
    }
  }

  private async readAndPush(
    path: string,
    _targetRole: string,
    session: AgentSession,
    sender: string,
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
        try {
          const { appendFileSync } = require("node:fs") as typeof import("node:fs");
          appendFileSync(
            "/tmp/grove-debug.log",
            `[${new Date().toISOString()}] [wsBridge.readAndPush] FAIL resp.status=${resp?.status ?? "none"} path=${path}\n`,
          );
        } catch {
          /* */
        }
        return;
      }

      const result = (await resp.json()) as { result?: { data?: string }; error?: unknown };
      if (!result.result?.data) {
        try {
          const { appendFileSync } = require("node:fs") as typeof import("node:fs");
          appendFileSync(
            "/tmp/grove-debug.log",
            `[${new Date().toISOString()}] [wsBridge.readAndPush] NO DATA path=${path} error=${JSON.stringify(result.error ?? "none").slice(0, 100)}\n`,
          );
        } catch {
          /* */
        }
        return;
      }

      const raw = Buffer.from(result.result.data, "base64").toString();
      const msg = JSON.parse(raw) as {
        from?: string;
        sender?: string;
        payload?: Record<string, unknown>;
      };

      const msgSender = msg.from ?? msg.sender ?? sender;
      const summary =
        (msg.payload?.summary as string) ??
        (msg.payload?.body as string) ??
        JSON.stringify(msg.payload ?? {}).slice(0, 100);
      const notification = `[IPC from ${msgSender}] ${summary}`;
      try {
        const { appendFileSync } = require("node:fs") as typeof import("node:fs");
        appendFileSync(
          "/tmp/grove-debug.log",
          `[${new Date().toISOString()}] [wsBridge.readAndPush] delivering to session=${session.id} role=${_targetRole} notification=${notification.slice(0, 80)}\n`,
        );
      } catch {
        /* */
      }

      void this.opts.runtime.send(session, notification).catch(() => {
        /* non-fatal */
      });
    } catch {
      // Non-fatal
    }
  }
}
