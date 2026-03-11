/**
 * CreditsService protocol — abstract payment interface.
 *
 * Defines the contract for two-phase credit operations (reserve/capture/void)
 * and simple transfers. Implementations include:
 * - InMemoryCreditsService (local dev/testing)
 * - NexusPayCreditsService (production, wrapping TigerBeetle via NexusPay)
 *
 * All amounts are unsigned integers in the smallest unit (e.g., 1 credit = 1).
 * Operations are idempotent when called with the same ID.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a reserve operation. */
export interface Reservation {
  /** Unique reservation ID for subsequent capture/void. */
  readonly reservationId: string;
  /** Amount reserved. */
  readonly amount: number;
  /** ISO 8601 timestamp when the reservation expires if not captured/voided. */
  readonly expiresAt: string;
}

/** Result of a balance query. */
export interface CreditBalance {
  /** Available credits (excluding pending reservations). */
  readonly available: number;
  /** Credits held in pending reservations. */
  readonly reserved: number;
  /** Total credits (available + reserved). */
  readonly total: number;
}

/** Result of a transfer operation. */
export interface TransferResult {
  readonly transferId: string;
  readonly amount: number;
  readonly fromAgentId: string;
  readonly toAgentId: string;
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/**
 * Abstract credits/payment service.
 *
 * Supports two-phase credit operations for bounty escrow:
 * 1. reserve() — lock credits (pending debit)
 * 2. capture() — finalize the reservation (commit)
 *    OR void() — cancel the reservation (rollback)
 *
 * Also supports direct transfers for reward distribution.
 */
export interface CreditsService {
  /**
   * Reserve credits for a bounty (phase 1 of two-phase).
   *
   * Locks the specified amount from the agent's available balance.
   * The reservation expires after `timeoutMs` if not captured or voided.
   *
   * Idempotent: calling with the same reservationId returns the existing reservation.
   *
   * @throws InsufficientCreditsError if available balance < amount
   * @throws PaymentError on upstream failure
   */
  reserve(opts: {
    readonly reservationId: string;
    readonly agentId: string;
    readonly amount: number;
    readonly timeoutMs: number;
  }): Promise<Reservation>;

  /**
   * Capture a reservation (phase 2a — commit).
   *
   * Finalizes the pending debit. Credits are permanently deducted from
   * the source agent. When `toAgentId` is provided, the captured amount
   * is atomically credited to that agent (matching TigerBeetle's
   * two-phase transfer semantics).
   *
   * Idempotent: capturing an already-captured reservation is a no-op,
   * provided `toAgentId` matches the original capture. Mismatched
   * `toAgentId` throws PaymentError to surface caller bugs.
   *
   * @param reservationId - The reservation to capture.
   * @param opts - Optional: destination agent for the captured funds.
   * @throws PaymentError if reservation not found, already voided, expired,
   *         or if idempotent retry has mismatched toAgentId
   */
  capture(reservationId: string, opts?: { toAgentId: string }): Promise<void>;

  /**
   * Void a reservation (phase 2b — rollback).
   *
   * Releases the reserved credits back to available balance.
   *
   * Idempotent: voiding an already-voided or already-captured reservation is a no-op.
   */
  void(reservationId: string): Promise<void>;

  /**
   * Transfer credits directly between agents.
   *
   * Used for reward distribution (not bounty escrow).
   *
   * Idempotent: calling with the same transferId returns success without
   * creating a duplicate transfer.
   *
   * @throws InsufficientCreditsError if source balance < amount
   * @throws PaymentError on upstream failure
   */
  transfer(opts: {
    readonly transferId: string;
    readonly fromAgentId: string;
    readonly toAgentId: string;
    readonly amount: number;
  }): Promise<TransferResult>;

  /**
   * Query an agent's credit balance.
   */
  balance(agentId: string): Promise<CreditBalance>;

  /**
   * Release resources (close connections, etc.).
   */
  close(): void;
}
