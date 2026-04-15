export const HandoffStatus = {
  PendingPickup: "pending_pickup",
  Delivered: "delivered",
  /** Agent acknowledged receipt and is processing the handoff. */
  Processed: "processed",
  Replied: "replied",
  Expired: "expired",
  /** IPC delivery failed after retries — requires operator attention. */
  DeadLettered: "dead_lettered",
} as const;

export type HandoffStatus = (typeof HandoffStatus)[keyof typeof HandoffStatus];

/**
 * Handoff delivery state machine.
 *
 * Happy path:  pending_pickup → delivered → processed → replied
 * IPC failure: pending_pickup → dead_lettered
 * TTL expiry:  pending_pickup → expired
 *
 * Terminal states: replied, expired, dead_lettered.
 */
const VALID_TRANSITIONS: ReadonlyMap<HandoffStatus, ReadonlySet<HandoffStatus>> = new Map([
  [
    HandoffStatus.PendingPickup,
    new Set([HandoffStatus.Delivered, HandoffStatus.Expired, HandoffStatus.DeadLettered]),
  ],
  [
    HandoffStatus.Delivered,
    new Set([
      HandoffStatus.Processed,
      HandoffStatus.Replied,
      HandoffStatus.Expired,
      HandoffStatus.DeadLettered,
    ]),
  ],
  [HandoffStatus.Processed, new Set([HandoffStatus.Replied, HandoffStatus.Expired])],
  // Terminal states — no outgoing transitions
  [HandoffStatus.Replied, new Set()],
  [HandoffStatus.Expired, new Set()],
  [HandoffStatus.DeadLettered, new Set()],
]);

/**
 * Check whether a status transition is valid.
 *
 * Returns true if `from → to` is a legal transition in the handoff
 * state machine. Returns false for invalid transitions and self-loops.
 */
export function canTransition(from: HandoffStatus, to: HandoffStatus): boolean {
  if (from === to) return false;
  return VALID_TRANSITIONS.get(from)?.has(to) ?? false;
}

export interface Handoff {
  readonly handoffId: string;
  readonly sourceCid: string;
  readonly fromRole: string;
  readonly toRole: string;
  readonly status: HandoffStatus;
  readonly requiresReply: boolean;
  readonly replyDueAt?: string | undefined;
  readonly resolvedByCid?: string | undefined;
  readonly createdAt: string;
  /** Nexus IPC message ID — set when the handoff is relayed via IPC. */
  readonly ipcMessageId?: string | undefined;
}

export interface HandoffInput {
  readonly handoffId?: string | undefined;
  readonly sourceCid: string;
  readonly fromRole: string;
  readonly toRole: string;
  readonly requiresReply?: boolean | undefined;
  readonly replyDueAt?: string | undefined;
}

export interface HandoffQuery {
  readonly toRole?: string | undefined;
  readonly fromRole?: string | undefined;
  readonly status?: HandoffStatus | readonly HandoffStatus[] | undefined;
  readonly sourceCid?: string | undefined;
  readonly limit?: number | undefined;
}

export interface HandoffStore {
  create(input: HandoffInput): Promise<Handoff>;
  /**
   * Create multiple handoff records in a single round-trip.
   *
   * Used by the contributeOperation serial write path to avoid an N+1
   * pattern when fanning a contribution out to multiple downstream roles
   * (e.g., coder → [reviewer, tester, auditor] would otherwise pay
   * 3×rtt against a remote handoff store).
   *
   * Implementations should preserve input order in the returned array.
   * Default implementation calls create() in a loop — override with
   * a single batch operation when the backing store supports it
   * (e.g., one HTTP POST for Nexus, one BEGIN/COMMIT for SQLite).
   */
  createMany?(inputs: readonly HandoffInput[]): Promise<readonly Handoff[]>;
  get(id: string): Promise<Handoff | undefined>;
  list(query?: HandoffQuery): Promise<readonly Handoff[]>;
  markDelivered(id: string): Promise<void>;
  /** Mark a handoff as processed (agent acknowledged and is acting on it). */
  markProcessed(id: string): Promise<void>;
  markReplied(id: string, resolvedByCid: string): Promise<void>;
  /** Mark a handoff as dead-lettered (IPC delivery failed after retries). */
  markDeadLettered(id: string): Promise<void>;
  /** Set the IPC message ID on a handoff (called after IPC relay succeeds). */
  setIpcMessageId?(id: string, ipcMessageId: string): Promise<void>;
  expireStale(now?: string): Promise<readonly Handoff[]>;
  countPending(toRole: string): Promise<number>;
  close(): void;
}
