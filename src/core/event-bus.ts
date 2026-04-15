/**
 * Event bus abstraction for agent communication.
 *
 * Three implementations:
 * - LocalEventBus: Node.js EventEmitter for single-machine setups (tests/local)
 * - NexusEventBus: Relays events via Nexus IPC API, returns message IDs
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

/** Result of publishing an event. */
export interface PublishResult {
  readonly ok: boolean;
  /** IPC message ID — present when the event was relayed via Nexus IPC. */
  readonly messageId?: string | undefined;
  readonly error?: string | undefined;
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
