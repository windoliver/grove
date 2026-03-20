/**
 * Event bus abstraction for agent communication.
 *
 * Two implementations:
 * - LocalEventBus: Node.js EventEmitter for single-machine setups
 * - Future: RedisEventBus, NatsEventBus for federated setups
 */

/** An event published through the bus. */
export interface GroveEvent {
  readonly type: "contribution" | "stop" | "idle";
  readonly sourceRole: string;
  readonly targetRole: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: string;
}

/** Callback for event subscriptions. */
export type EventHandler = (event: GroveEvent) => void;

/** Event bus for ephemeral agent notifications. */
export interface EventBus {
  /** Publish an event. */
  publish(event: GroveEvent): void;
  /** Subscribe to events for a specific role. */
  subscribe(role: string, handler: EventHandler): void;
  /** Unsubscribe a handler. */
  unsubscribe(role: string, handler: EventHandler): void;
  /** Close the bus and release resources. */
  close(): void;
}
