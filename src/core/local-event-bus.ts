import { EventEmitter } from "node:events";
import type { EventBus, EventHandler, GroveEvent, PublishResult } from "./event-bus.js";

/**
 * Local event bus using Node.js EventEmitter.
 * Suitable for single-machine, single-process setups.
 * Events are ephemeral — lost if no subscriber is listening.
 */
export class LocalEventBus implements EventBus {
  private emitter = new EventEmitter();

  constructor() {
    // Allow many role subscriptions without warnings
    this.emitter.setMaxListeners(100);
  }

  async publish(event: GroveEvent): Promise<PublishResult> {
    return this.publishLocal(event);
  }

  async publishLocal(event: GroveEvent): Promise<PublishResult> {
    // Wrap each listener in try/catch so one crashed subscriber doesn't break others
    const channel = `role:${event.targetRole}`;
    for (const listener of this.emitter.listeners(channel)) {
      try {
        (listener as EventHandler)(event);
      } catch (err) {
        process.stderr.write(
          `[LocalEventBus] subscriber crashed on ${channel}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    return { ok: true };
  }

  subscribe(role: string, handler: EventHandler): void {
    this.emitter.on(`role:${role}`, handler);
  }

  unsubscribe(role: string, handler: EventHandler): void {
    this.emitter.off(`role:${role}`, handler);
  }

  close(): void {
    this.emitter.removeAllListeners();
  }
}
