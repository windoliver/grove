/**
 * In-memory CreditsService implementation for testing and local development.
 *
 * Supports configurable failure injection for testing error paths.
 * All state is in-memory — no persistence.
 */

import { InsufficientCreditsError, PaymentError } from "./bounty-errors.js";
import type { CreditBalance, CreditsService, Reservation, TransferResult } from "./credits.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for failure injection in tests. */
export interface FailureConfig {
  /** Error to throw on reserve() calls. */
  readonly reserve?: Error | undefined;
  /** Error to throw on capture() calls. */
  readonly capture?: Error | undefined;
  /** Error to throw on void() calls. */
  readonly void?: Error | undefined;
  /** Error to throw on transfer() calls. */
  readonly transfer?: Error | undefined;
}

interface PendingReservation {
  readonly reservationId: string;
  readonly agentId: string;
  readonly amount: number;
  readonly expiresAt: string;
  readonly captured: boolean;
  readonly voided: boolean;
  /** Agent that received the captured funds (set during capture with toAgentId). */
  readonly capturedToAgentId?: string | undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * In-memory credits service.
 *
 * Tracks balances per agent and pending reservations.
 * Supports configurable failure injection for testing error paths.
 */
export class InMemoryCreditsService implements CreditsService {
  private readonly balances = new Map<string, number>();
  private readonly reservations = new Map<string, PendingReservation>();
  private readonly completedTransfers = new Map<string, TransferResult>();
  private failureConfig: FailureConfig;

  constructor(failureConfig?: FailureConfig) {
    this.failureConfig = failureConfig ?? {};
  }

  /**
   * Seed balance for an agent (test helper).
   * Not part of the CreditsService protocol.
   */
  seed(agentId: string, amount: number): void {
    const current = this.balances.get(agentId) ?? 0;
    this.balances.set(agentId, current + amount);
  }

  /** Update failure config at runtime (for mid-test failure injection). */
  setFailures(config: FailureConfig): void {
    this.failureConfig = config;
  }

  async reserve(opts: {
    readonly reservationId: string;
    readonly agentId: string;
    readonly amount: number;
    readonly timeoutMs: number;
  }): Promise<Reservation> {
    if (this.failureConfig.reserve) {
      throw this.failureConfig.reserve;
    }

    validatePositiveInteger(opts.amount, "reserve");

    // Idempotent: return existing reservation if parameters match
    const existing = this.reservations.get(opts.reservationId);
    if (existing !== undefined) {
      if (existing.agentId !== opts.agentId || existing.amount !== opts.amount) {
        throw new PaymentError({
          operation: "reserve",
          message:
            `Reservation '${opts.reservationId}' already exists with different parameters` +
            ` (agent: ${existing.agentId}, amount: ${existing.amount})`,
        });
      }
      return {
        reservationId: existing.reservationId,
        amount: existing.amount,
        expiresAt: existing.expiresAt,
      };
    }

    const available = this.getAvailable(opts.agentId);
    if (available < opts.amount) {
      throw new InsufficientCreditsError({
        available,
        required: opts.amount,
      });
    }

    const expiresAt = new Date(Date.now() + opts.timeoutMs).toISOString();
    const reservation: PendingReservation = {
      reservationId: opts.reservationId,
      agentId: opts.agentId,
      amount: opts.amount,
      expiresAt,
      captured: false,
      voided: false,
    };
    this.reservations.set(opts.reservationId, reservation);

    return {
      reservationId: reservation.reservationId,
      amount: reservation.amount,
      expiresAt: reservation.expiresAt,
    };
  }

  async capture(reservationId: string, opts?: { toAgentId: string }): Promise<void> {
    if (this.failureConfig.capture) {
      throw this.failureConfig.capture;
    }

    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined) {
      throw new PaymentError({ operation: "capture", message: `Reservation '${reservationId}' not found` });
    }

    // Idempotent: already captured — verify toAgentId matches
    if (reservation.captured) {
      const requestedTo = opts?.toAgentId;
      const originalTo = reservation.capturedToAgentId;
      if (requestedTo !== originalTo) {
        throw new PaymentError({
          operation: "capture",
          message:
            `Reservation '${reservationId}' already captured with different toAgentId` +
            ` (original: ${originalTo ?? "none"}, requested: ${requestedTo ?? "none"})`,
        });
      }
      return;
    }

    if (reservation.voided) {
      throw new PaymentError({
        operation: "capture",
        message: `Reservation '${reservationId}' already voided`,
      });
    }

    // Reject expired reservations — the hold has already been released
    if (new Date(reservation.expiresAt).getTime() <= Date.now()) {
      throw new PaymentError({
        operation: "capture",
        message: `Reservation '${reservationId}' has expired`,
      });
    }

    // Deduct from total balance
    const current = this.balances.get(reservation.agentId) ?? 0;
    this.balances.set(reservation.agentId, current - reservation.amount);

    // Credit the destination agent if specified (atomic capture+transfer)
    if (opts?.toAgentId) {
      const toBalance = this.balances.get(opts.toAgentId) ?? 0;
      this.balances.set(opts.toAgentId, toBalance + reservation.amount);
    }

    // Mark as captured
    this.reservations.set(reservationId, {
      ...reservation,
      captured: true,
      capturedToAgentId: opts?.toAgentId,
    });
  }

  async void(reservationId: string): Promise<void> {
    if (this.failureConfig.void) {
      throw this.failureConfig.void;
    }

    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined) {
      return; // Idempotent: nothing to void
    }

    // Already captured — void is a no-op
    if (reservation.captured) {
      return;
    }

    // Already voided — idempotent
    if (reservation.voided) {
      return;
    }

    // Release reservation (no balance change — credits were never deducted)
    this.reservations.set(reservationId, { ...reservation, voided: true });
  }

  async transfer(opts: {
    readonly transferId: string;
    readonly fromAgentId: string;
    readonly toAgentId: string;
    readonly amount: number;
  }): Promise<TransferResult> {
    if (this.failureConfig.transfer) {
      throw this.failureConfig.transfer;
    }

    validatePositiveInteger(opts.amount, "transfer");

    // Idempotent: return existing transfer if parameters match
    const existing = this.completedTransfers.get(opts.transferId);
    if (existing !== undefined) {
      if (
        existing.fromAgentId !== opts.fromAgentId ||
        existing.toAgentId !== opts.toAgentId ||
        existing.amount !== opts.amount
      ) {
        throw new PaymentError({
          operation: "transfer",
          message:
            `Transfer '${opts.transferId}' already exists with different parameters` +
            ` (from: ${existing.fromAgentId}, to: ${existing.toAgentId}, amount: ${existing.amount})`,
        });
      }
      return existing;
    }

    const available = this.getAvailable(opts.fromAgentId);
    if (available < opts.amount) {
      throw new InsufficientCreditsError({
        available,
        required: opts.amount,
      });
    }

    // Move credits (handle self-transfer correctly by sequential mutation)
    const fromBalance = this.balances.get(opts.fromAgentId) ?? 0;
    this.balances.set(opts.fromAgentId, fromBalance - opts.amount);
    const toBalance = this.balances.get(opts.toAgentId) ?? 0;
    this.balances.set(opts.toAgentId, toBalance + opts.amount);

    const result: TransferResult = {
      transferId: opts.transferId,
      amount: opts.amount,
      fromAgentId: opts.fromAgentId,
      toAgentId: opts.toAgentId,
    };
    this.completedTransfers.set(opts.transferId, result);
    return result;
  }

  async balance(agentId: string): Promise<CreditBalance> {
    const total = this.balances.get(agentId) ?? 0;
    const reserved = this.getReserved(agentId);
    return {
      available: total - reserved,
      reserved,
      total,
    };
  }

  close(): void {
    this.balances.clear();
    this.reservations.clear();
    this.completedTransfers.clear();
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  private getAvailable(agentId: string): number {
    const total = this.balances.get(agentId) ?? 0;
    return total - this.getReserved(agentId);
  }

  private getReserved(agentId: string): number {
    const now = Date.now();
    let reserved = 0;
    for (const res of this.reservations.values()) {
      if (res.agentId === agentId && !res.captured && !res.voided) {
        // Skip expired reservations — they no longer hold funds
        if (new Date(res.expiresAt).getTime() <= now) {
          continue;
        }
        reserved += res.amount;
      }
    }
    return reserved;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Ensure amount is a positive integer. */
function validatePositiveInteger(amount: number, operation: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new PaymentError({
      operation,
      message: `Amount must be a positive integer, got ${amount}`,
    });
  }
}
