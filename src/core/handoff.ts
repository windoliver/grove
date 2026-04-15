export const HandoffStatus = {
  PendingPickup: "pending_pickup",
  Delivered: "delivered",
  Replied: "replied",
  Expired: "expired",
} as const;

export type HandoffStatus = (typeof HandoffStatus)[keyof typeof HandoffStatus];

/**
 * Valid status transitions for handoffs.
 *
 * pending_pickup → delivered → replied
 * pending_pickup → replied (direct reply without explicit delivery marking)
 * pending_pickup → expired
 * delivered → expired
 *
 * Terminal states (replied, expired) cannot transition further.
 */
export const VALID_TRANSITIONS: Readonly<Record<HandoffStatus, readonly HandoffStatus[]>> = {
  [HandoffStatus.PendingPickup]: [HandoffStatus.Delivered, HandoffStatus.Replied, HandoffStatus.Expired],
  [HandoffStatus.Delivered]: [HandoffStatus.Replied, HandoffStatus.Expired],
  [HandoffStatus.Replied]: [],
  [HandoffStatus.Expired]: [],
};

/**
 * Thrown when a handoff status transition is invalid (e.g., expired → delivered).
 */
export class InvalidTransitionError extends Error {
  readonly handoffId: string;
  readonly fromStatus: HandoffStatus;
  readonly toStatus: HandoffStatus;

  constructor(handoffId: string, fromStatus: HandoffStatus, toStatus: HandoffStatus) {
    super(
      `Invalid handoff transition: '${fromStatus}' → '${toStatus}' for handoff '${handoffId}'`,
    );
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
  markReplied(id: string, resolvedByCid: string): Promise<void>;
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
  close(): void;
}
