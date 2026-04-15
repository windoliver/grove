/**
 * Nexus-backed EventBus — publish via Nexus IPC API.
 *
 * On publish: sends via NexusIpcClient (POST /api/v2/ipc/send).
 * Returns structured PublishResult with IPC message ID.
 *
 * On subscribe: registers in-process handlers only (no polling).
 * Cross-process push is handled by NexusWsBridge via Nexus SSE stream.
 */

import type { EventBus, EventHandler, GroveEvent, PublishResult } from "../core/event-bus.js";
import type { NexusIpcClient } from "./nexus-ipc-client.js";

/** Nexus IPC-backed event bus for cross-process agent communication. */
export class NexusEventBus implements EventBus {
  private readonly ipcClient: NexusIpcClient | undefined;
  private readonly handlers = new Map<string, EventHandler[]>();

  /**
   * @param ipcClient — Shared IPC client for sending messages. When undefined,
   *   the bus operates in local-only mode (handlers fire, no IPC send).
   */
  constructor(ipcClient: NexusIpcClient | undefined) {
    this.ipcClient = ipcClient;
  }

  async publish(event: GroveEvent): Promise<PublishResult> {
    let result: PublishResult = { ok: true };

    // Send via Nexus IPC when available
    if (this.ipcClient !== undefined) {
      result = await this.ipcClient.send(event.sourceRole, event.targetRole, event.payload);
    }

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

    return result;
  }

  subscribe(role: string, handler: EventHandler): void {
    let handlers = this.handlers.get(role);
    if (!handlers) {
      handlers = [];
      this.handlers.set(role, handlers);
    }
    handlers.push(handler);
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
