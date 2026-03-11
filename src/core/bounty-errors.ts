/**
 * Typed error hierarchy for bounty and payment violations.
 *
 * Maps to HTTP status codes:
 * - InsufficientCreditsError → 402 Payment Required / 422
 * - BountyStateError → 409 Conflict
 * - PaymentError → 502 Bad Gateway (upstream payment failure)
 */

import { GroveError } from "./errors.js";

/** Thrown when an agent doesn't have enough credits to fund a bounty. */
export class InsufficientCreditsError extends GroveError {
  readonly available: number;
  readonly required: number;

  constructor(opts: { available: number; required: number; message?: string }) {
    const msg =
      opts.message ??
      `Insufficient credits: ${opts.available} available, ${opts.required} required`;
    super(msg);
    this.name = "InsufficientCreditsError";
    this.available = opts.available;
    this.required = opts.required;
  }
}

/** Thrown when a bounty state transition is invalid. */
export class BountyStateError extends GroveError {
  readonly bountyId: string;
  readonly currentStatus: string;
  readonly attemptedAction: string;

  constructor(opts: {
    bountyId: string;
    currentStatus: string;
    attemptedAction: string;
    message?: string;
  }) {
    const msg =
      opts.message ??
      `Invalid bounty state: cannot ${opts.attemptedAction} bounty '${opts.bountyId}' in status '${opts.currentStatus}'`;
    super(msg);
    this.name = "BountyStateError";
    this.bountyId = opts.bountyId;
    this.currentStatus = opts.currentStatus;
    this.attemptedAction = opts.attemptedAction;
  }
}

/** Thrown when an upstream payment service operation fails. */
export class PaymentError extends GroveError {
  readonly operation: string;
  override readonly cause?: Error | undefined;

  constructor(opts: { operation: string; cause?: Error; message?: string }) {
    const msg =
      opts.message ??
      `Payment operation '${opts.operation}' failed${opts.cause ? `: ${opts.cause.message}` : ""}`;
    super(msg);
    this.name = "PaymentError";
    this.operation = opts.operation;
    this.cause = opts.cause;
  }
}
