export const HandoffStatus = {
  PendingPickup: "pending_pickup",
  Delivered: "delivered",
  /** Agent acknowledged receipt and is processing the handoff. */
  Processed: "processed",
  Replied: "replied",
  Expired: "expired",
  /** IPC delivery failed after retries — requires operator attention. */
  DeadLettered: "dead_lettered",
  Cancelled: "cancelled",
  ManuallyResolved: "manually_resolved",
} as const;

export type HandoffStatus = (typeof HandoffStatus)[keyof typeof HandoffStatus];

export interface HandoffTerminalMetadata {
  readonly terminalReason?: string | undefined;
  readonly replacementHandoffId?: string | undefined;
}

/**
 * Valid status transitions for handoffs.
 *
 * Happy path:  pending_pickup → delivered → processed → replied
 *              pending_pickup → delivered → replied (skip processed)
 * IPC failure: pending_pickup → dead_lettered
 *              delivered → dead_lettered
 * TTL expiry:  pending_pickup → expired
 *              delivered → expired
 *              processed → expired
 * Operator:    pending_pickup/delivered/processed/expired/dead_lettered
 *              → cancelled/manually_resolved
 *
 * pending_pickup → replied is NOT allowed: a reply must acknowledge delivery
 * first. Callers that want to atomically deliver-and-reply should call
 * markDelivered() then markReplied().
 *
 * Terminal states (replied, cancelled, manually_resolved) cannot transition further.
 */
export const VALID_TRANSITIONS: Readonly<Record<HandoffStatus, readonly HandoffStatus[]>> = {
  [HandoffStatus.PendingPickup]: [
    HandoffStatus.Delivered,
    HandoffStatus.Expired,
    HandoffStatus.DeadLettered,
    HandoffStatus.Cancelled,
    HandoffStatus.ManuallyResolved,
  ],
  [HandoffStatus.Delivered]: [
    HandoffStatus.Processed,
    HandoffStatus.Replied,
    HandoffStatus.Expired,
    HandoffStatus.DeadLettered,
    HandoffStatus.Cancelled,
    HandoffStatus.ManuallyResolved,
  ],
  [HandoffStatus.Processed]: [
    HandoffStatus.Replied,
    HandoffStatus.Expired,
    HandoffStatus.Cancelled,
    HandoffStatus.ManuallyResolved,
  ],
  [HandoffStatus.Replied]: [],
  [HandoffStatus.Expired]: [HandoffStatus.Cancelled, HandoffStatus.ManuallyResolved],
  [HandoffStatus.DeadLettered]: [HandoffStatus.Cancelled, HandoffStatus.ManuallyResolved],
  [HandoffStatus.Cancelled]: [],
  [HandoffStatus.ManuallyResolved]: [],
};

/**
 * Thrown when a handoff status transition is invalid (e.g., expired → delivered).
 */
export class InvalidTransitionError extends Error {
  readonly handoffId: string;
  readonly fromStatus: HandoffStatus;
  readonly toStatus: HandoffStatus;

  constructor(handoffId: string, fromStatus: HandoffStatus, toStatus: HandoffStatus) {
    super(`Invalid handoff transition: '${fromStatus}' → '${toStatus}' for handoff '${handoffId}'`);
    this.name = "InvalidTransitionError";
    this.handoffId = handoffId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

/**
 * Validate a handoff status transition. Throws InvalidTransitionError if invalid.
 */
export function validateTransition(
  handoffId: string,
  currentStatus: HandoffStatus,
  targetStatus: HandoffStatus,
): void {
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed.includes(targetStatus)) {
    throw new InvalidTransitionError(handoffId, currentStatus, targetStatus);
  }
}

/**
 * Check whether a status transition is valid (boolean form).
 *
 * Returns true if `from → to` is a legal transition. Returns false for
 * invalid transitions and self-loops. Used by callers that want a
 * predicate without the throw-on-error semantics of validateTransition.
 */
export function canTransition(from: HandoffStatus, to: HandoffStatus): boolean {
  if (from === to) return false;
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
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
  /** ISO 8601 timestamp when the target agent first observed this handoff. */
  readonly seenAt?: string | undefined;
  /** ISO 8601 timestamp when the target agent acknowledged intent to act. */
  readonly ackedAt?: string | undefined;
  readonly createdAt: string;
  /** Nexus IPC message ID — set when the handoff is relayed via IPC. */
  readonly ipcMessageId?: string | undefined;
  readonly terminalReason?: string | undefined;
  readonly replacementHandoffId?: string | undefined;
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
  markCancelled(id: string, metadata?: HandoffTerminalMetadata): Promise<void>;
  markManuallyResolved(id: string, metadata?: HandoffTerminalMetadata): Promise<void>;
  /** Set the IPC message ID on a handoff (called after IPC relay succeeds). */
  setIpcMessageId?(id: string, ipcMessageId: string): Promise<void>;
  /**
   * Record that the target agent has seen this handoff.
   * Sets seenAt if not already set. No-op if already seen.
   */
  markSeen(id: string): Promise<void>;
  /**
   * Record that the target agent acknowledges this handoff and intends to act.
   * Sets ackedAt (and seenAt if not already set). No-op if already acked.
   */
  markAcked(id: string): Promise<void>;
  expireStale(now?: string): Promise<readonly Handoff[]>;
  countPending(toRole: string): Promise<number>;
  /**
   * Session-scoped enumeration for deadline rebuild on MCP server startup.
   *
   * Unlike list() which may return handoffs across all sessions (Nexus
   * scans the zone-wide directory), this must ONLY return handoffs created
   * within the active session. Without this scoping, a restarting MCP
   * server for session A could re-arm timers for session B's handoffs
   * and emit cross-session overdue events.
   *
   * Absence of the method signals "session scoping is not supported on
   * this backend" — callers (DeadlineWatcher rebuild, grove_ack_handoff
   * authorization) use that as a signal to disable features that require
   * it.
   */
  listForCurrentSession?(query?: HandoffQuery): Promise<readonly Handoff[]>;
  /**
   * O(1) session ownership check. Returns true iff the handoff exists AND
   * belongs to the caller's current session. Used by grove_ack_handoff to
   * reject cross-session receipt mutations without a full enumeration scan
   * (which is bounded in memory and unusable for sessions with many
   * handoffs).
   *
   * Absence of the method means the backend does not support session-
   * scoped receipt mutations at all.
   */
  isInCurrentSession?(handoffId: string): Promise<boolean>;
  close(): void;
}
