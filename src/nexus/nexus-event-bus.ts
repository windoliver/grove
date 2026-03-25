/**
 * Nexus-backed EventBus — publish writes to Nexus IPC API + VFS inbox.
 *
 * On publish: sends via POST /api/v2/ipc/send and writes to VFS inbox.
 * Both paths trigger Nexus SSE events which NexusWsBridge receives.
 *
 * On subscribe: registers in-process handlers only (no polling).
 * Cross-process push is handled by NexusWsBridge via Nexus SSE stream.
 */

import type { EventBus, EventHandler, GroveEvent } from "../core/event-bus.js";
import type { NexusClient } from "./client.js";

const AGENTS_ROOT = "/agents";

/** Nexus VFS-backed event bus for cross-process agent communication. */
export class NexusEventBus implements EventBus {
  private readonly client: NexusClient;

  private readonly handlers = new Map<string, EventHandler[]>();

  constructor(client: NexusClient, _zoneId: string) {
    this.client = client;
  }

  publish(event: GroveEvent): void {
    // Send via Nexus IPC API — triggers SSE push to subscribers
    const nexusUrl = (this.client as { baseUrl?: string }).baseUrl ?? process.env.GROVE_NEXUS_URL;
    const apiKey = process.env.NEXUS_API_KEY;

    if (nexusUrl && apiKey) {
      void fetch(`${nexusUrl}/api/v2/ipc/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          sender: event.sourceRole,
          recipient: event.targetRole,
          type: "event",
          payload: event.payload,
        }),
      }).catch(() => {
        /* best-effort */
      });
    }

    // Also write to VFS inbox as backup (triggers SSE via write observer)
    const inboxPath = `${AGENTS_ROOT}/${event.targetRole}/inbox/${Date.now()}-${event.type}.json`;
    const data = new TextEncoder().encode(JSON.stringify(event));
    void this.client.write(inboxPath, data).catch(() => {
      // Non-fatal — event delivery is best-effort
    });

    // Also notify local handlers (for in-process subscribers)
    const handlers = this.handlers.get(event.targetRole);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // Handler errors are non-fatal
        }
      }
    }
  }

  subscribe(role: string, handler: EventHandler): void {
    let handlers = this.handlers.get(role);
    if (!handlers) {
      handlers = [];
      this.handlers.set(role, handlers);
    }
    handlers.push(handler);
    // No polling — cross-process push is handled by NexusWsBridge (SSE).
    // This subscribe only registers local in-process handlers for publish().
  }

  unsubscribe(role: string, handler: EventHandler): void {
    const handlers = this.handlers.get(role);
    if (!handlers) return;
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);

    if (handlers.length === 0) {
      this.handlers.delete(role);
    }
  }

  close(): void {
    this.handlers.clear();
  }
}
