/**
 * Event bus abstraction for agent communication.
 *
 * Three implementations:
 * - LocalEventBus: Node.js EventEmitter for single-machine setups (tests/local)
 * - NexusEventBus: Relays events via Nexus IPC API, returns message IDs
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

/** Result of publishing an event. */
export interface PublishResult {
  readonly ok: boolean;
  /** IPC message ID — present when the event was relayed via Nexus IPC. */
  readonly messageId?: string | undefined;
  readonly error?: string | undefined;
  /** True when failure is infrastructure (404, connection refused), not delivery rejection. */
  readonly infrastructureError?: boolean | undefined;
}

/** Callback for event subscriptions. */
export type EventHandler = (event: GroveEvent) => void;

/** Event bus for ephemeral agent notifications. */
export interface EventBus {
  /** Publish an event. Returns delivery result with optional IPC message ID. */
  publish(event: GroveEvent): Promise<PublishResult>;
  /** Subscribe to events for a specific role. */
  subscribe(role: string, handler: EventHandler): void;
  /** Unsubscribe a handler. */
  unsubscribe(role: string, handler: EventHandler): void;
  /** Close the bus and release resources. */
  close(): void;
}
