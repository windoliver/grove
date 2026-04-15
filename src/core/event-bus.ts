/**
 * Event bus abstraction for agent communication.
 *
 * Two implementations:
 * - LocalEventBus: Node.js EventEmitter for single-machine setups
 * - Future: RedisEventBus, NatsEventBus for federated setups
 */

/**
 * An event published through the bus.
 *
 * Convention for type names: "namespace.action"
 *   - contribution  — a contribution was created
 *   - stop          — session termination signal
 *   - idle          — agent entered idle state
 *   - handoff.overdue — a handoff reply deadline has passed
 *   - handoff.seen  — a handoff was observed by the target agent
 *   - handoff.acked — a handoff was acknowledged by the target agent
 */
export interface GroveEvent {
  readonly type: string;
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
