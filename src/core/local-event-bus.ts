import { EventEmitter } from "node:events";
import type { EventBus, EventHandler, GroveEvent } from "./event-bus.js";

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

  publish(event: GroveEvent): void {
    this.emitter.emit(`role:${event.targetRole}`, event);
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
