import type { Database, Statement } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { InsufficientCreditsError, PaymentError } from "../core/bounty-errors.js";
import type {
  CreditBalance,
  CreditsService,
  Reservation,
  TransferResult,
} from "../core/credits.js";
import {
  DEFAULT_CREDITS_INITIAL_BALANCE,
  DEFAULT_CREDITS_REWARD_TREASURY_BALANCE,
  FRONTIER_REWARD_TREASURY_AGENT_ID,
} from "../core/credits-constants.js";

export const SQLITE_CREDITS_DDL = `
  CREATE TABLE IF NOT EXISTS credit_accounts (
    agent_id TEXT PRIMARY KEY,
    balance INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS credit_reservations (
    reservation_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,
    captured_to_agent_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_credit_reservations_agent_status
    ON credit_reservations(agent_id, status, expires_at);

  CREATE TABLE IF NOT EXISTS credit_transfers (
    transfer_id TEXT PRIMARY KEY,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    transfer_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

export interface SqliteCreditsServiceOptions {
  readonly initialBalance?: number | undefined;
  readonly rewardTreasuryBalance?: number | undefined;
}

interface AccountRow {
  readonly balance: number;
}

interface ReservationRow {
  readonly reservation_id: string;
  readonly agent_id: string;
  readonly amount: number;
  readonly expires_at: string;
  readonly status: string;
  readonly captured_to_agent_id: string | null;
}

interface TransferRow {
  readonly from_agent_id: string;
  readonly to_agent_id: string;
  readonly amount: number;
}

export class SqliteCreditsService implements CreditsService {
  private readonly db: Database;
  private readonly initialBalance: number;
  private readonly rewardTreasuryBalance: number;
  private readonly getAccountStmt: Statement;
  private readonly insertAccountStmt: Statement;
  private readonly updateAccountBalanceStmt: Statement;
  private readonly getReservationStmt: Statement;
  private readonly insertReservationStmt: Statement;
  private readonly updateReservationStatusStmt: Statement;
  private readonly getReservedStmt: Statement;
  private readonly getTransferStmt: Statement;
  private readonly insertTransferStmt: Statement;

  constructor(db: Database, options?: SqliteCreditsServiceOptions) {
    this.db = db;
    this.db.exec(SQLITE_CREDITS_DDL);
    this.initialBalance = resolveNonNegativeIntegerOption(
      options?.initialBalance,
      "GROVE_CREDITS_INITIAL_BALANCE",
      DEFAULT_CREDITS_INITIAL_BALANCE,
    );
    this.rewardTreasuryBalance = resolveNonNegativeIntegerOption(
      options?.rewardTreasuryBalance,
      "GROVE_CREDITS_REWARD_TREASURY_BALANCE",
      DEFAULT_CREDITS_REWARD_TREASURY_BALANCE,
    );

    this.getAccountStmt = db.prepare("SELECT balance FROM credit_accounts WHERE agent_id = ?");
    this.insertAccountStmt = db.prepare(
      `INSERT OR IGNORE INTO credit_accounts (agent_id, balance, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    this.updateAccountBalanceStmt = db.prepare(
      "UPDATE credit_accounts SET balance = balance + ?, updated_at = ? WHERE agent_id = ?",
    );
    this.getReservationStmt = db.prepare(
      `SELECT reservation_id, agent_id, amount, expires_at, status, captured_to_agent_id
       FROM credit_reservations
       WHERE reservation_id = ?`,
    );
    this.insertReservationStmt = db.prepare(
      `INSERT INTO credit_reservations
         (reservation_id, agent_id, amount, expires_at, status, captured_to_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
    );
    this.updateReservationStatusStmt = db.prepare(
      `UPDATE credit_reservations
       SET status = ?, captured_to_agent_id = ?, updated_at = ?
       WHERE reservation_id = ?`,
    );
    this.getReservedStmt = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS reserved
       FROM credit_reservations
       WHERE agent_id = ? AND status = 'pending' AND expires_at > ?`,
    );
    this.getTransferStmt = db.prepare(
      "SELECT from_agent_id, to_agent_id, amount FROM credit_transfers WHERE transfer_id = ?",
    );
    this.insertTransferStmt = db.prepare(
      `INSERT INTO credit_transfers
         (transfer_id, from_agent_id, to_agent_id, amount, transfer_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
  }

  seed(agentId: string, amount: number): void {
    validatePositiveInteger(amount, "seed");
    const tx = this.db.transaction(() => {
      this.ensureAccount(agentId, 0);
      this.addBalance(agentId, amount);
      this.insertTransferStmt.run(
        `seed:${randomUUID()}`,
        "system:seed",
        agentId,
        amount,
        "seed",
        nowIso(),
      );
    });
    tx.immediate();
  }

  async reserve(opts: {
    readonly reservationId: string;
    readonly agentId: string;
    readonly amount: number;
    readonly timeoutMs: number;
  }): Promise<Reservation> {
    validatePositiveInteger(opts.amount, "reserve");
    const tx = this.db.transaction((): Reservation => {
      const existing = this.getReservation(opts.reservationId);
      if (existing !== undefined) {
        if (existing.agent_id !== opts.agentId || existing.amount !== opts.amount) {
          throw new PaymentError({
            operation: "reserve",
            message: `Reservation '${opts.reservationId}' already exists with different parameters`,
          });
        }
        return rowToReservation(existing);
      }

      this.ensureAccount(opts.agentId, this.bootstrapBalanceFor(opts.agentId));
      const available = this.availableFor(opts.agentId);
      if (available < opts.amount) {
        throw new InsufficientCreditsError({ available, required: opts.amount });
      }

      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + opts.timeoutMs).toISOString();
      this.insertReservationStmt.run(
        opts.reservationId,
        opts.agentId,
        opts.amount,
        expiresAt,
        createdAt,
        createdAt,
      );
      return { reservationId: opts.reservationId, amount: opts.amount, expiresAt };
    });
    return tx.immediate();
  }

  async capture(reservationId: string, opts?: { toAgentId: string }): Promise<void> {
    const tx = this.db.transaction(() => {
      const reservation = this.getReservation(reservationId);
      if (reservation === undefined) {
        throw new PaymentError({
          operation: "capture",
          message: `Reservation '${reservationId}' not found`,
        });
      }

      const requestedTo = opts?.toAgentId;
      if (reservation.status === "captured") {
        if (requestedTo !== (reservation.captured_to_agent_id ?? undefined)) {
          throw new PaymentError({
            operation: "capture",
            message: `Reservation '${reservationId}' already captured with different toAgentId`,
          });
        }
        return;
      }
      if (reservation.status === "voided") {
        throw new PaymentError({
          operation: "capture",
          message: `Reservation '${reservationId}' already voided`,
        });
      }
      if (new Date(reservation.expires_at).getTime() <= Date.now()) {
        throw new PaymentError({
          operation: "capture",
          message: `Reservation '${reservationId}' has expired`,
        });
      }

      this.addBalance(reservation.agent_id, -reservation.amount);
      if (requestedTo !== undefined) {
        this.ensureAccount(requestedTo, this.bootstrapBalanceFor(requestedTo));
        this.addBalance(requestedTo, reservation.amount);
      }
      this.updateReservationStatusStmt.run(
        "captured",
        requestedTo ?? null,
        nowIso(),
        reservationId,
      );
      this.db
        .prepare(
          `INSERT OR IGNORE INTO credit_transfers
             (transfer_id, from_agent_id, to_agent_id, amount, transfer_type, created_at)
           VALUES (?, ?, ?, ?, 'capture', ?)`,
        )
        .run(
          `capture:${reservationId}`,
          reservation.agent_id,
          requestedTo ?? "system:captured-credits",
          reservation.amount,
          nowIso(),
        );
    });
    tx.immediate();
  }

  async void(reservationId: string): Promise<void> {
    const tx = this.db.transaction(() => {
      const reservation = this.getReservation(reservationId);
      if (
        reservation === undefined ||
        reservation.status === "voided" ||
        reservation.status === "captured"
      ) {
        return;
      }
      this.updateReservationStatusStmt.run("voided", null, nowIso(), reservationId);
    });
    tx.immediate();
  }

  async transfer(opts: {
    readonly transferId: string;
    readonly fromAgentId: string;
    readonly toAgentId: string;
    readonly amount: number;
  }): Promise<TransferResult> {
    validatePositiveInteger(opts.amount, "transfer");
    const tx = this.db.transaction((): TransferResult => {
      const existing = this.getTransfer(opts.transferId);
      if (existing !== undefined) {
        if (
          existing.from_agent_id !== opts.fromAgentId ||
          existing.to_agent_id !== opts.toAgentId ||
          existing.amount !== opts.amount
        ) {
          throw new PaymentError({
            operation: "transfer",
            message: `Transfer '${opts.transferId}' already exists with different parameters`,
          });
        }
        return {
          transferId: opts.transferId,
          fromAgentId: existing.from_agent_id,
          toAgentId: existing.to_agent_id,
          amount: existing.amount,
        };
      }

      this.ensureAccount(opts.fromAgentId, this.bootstrapBalanceFor(opts.fromAgentId));
      this.ensureAccount(opts.toAgentId, this.bootstrapBalanceFor(opts.toAgentId));
      const available = this.availableFor(opts.fromAgentId);
      if (available < opts.amount) {
        throw new InsufficientCreditsError({ available, required: opts.amount });
      }

      if (opts.fromAgentId !== opts.toAgentId) {
        this.addBalance(opts.fromAgentId, -opts.amount);
        this.addBalance(opts.toAgentId, opts.amount);
      }
      this.insertTransferStmt.run(
        opts.transferId,
        opts.fromAgentId,
        opts.toAgentId,
        opts.amount,
        "transfer",
        nowIso(),
      );
      return opts;
    });
    return tx.immediate();
  }

  async balance(agentId: string): Promise<CreditBalance> {
    const tx = this.db.transaction((): CreditBalance => {
      this.ensureAccount(agentId, this.bootstrapBalanceFor(agentId));
      const total = this.accountBalance(agentId);
      const reserved = this.reservedFor(agentId);
      return { available: total - reserved, reserved, total };
    });
    return tx.immediate();
  }

  close(): void {
    // Database ownership stays with the SQLite store factory/runtime.
  }

  private ensureAccount(agentId: string, bootstrapBalance: number): void {
    const timestamp = nowIso();
    const result = this.insertAccountStmt.run(agentId, bootstrapBalance, timestamp, timestamp);
    if (result.changes === 1 && bootstrapBalance > 0) {
      this.insertTransferStmt.run(
        `bootstrap:${agentId}`,
        "system:bootstrap",
        agentId,
        bootstrapBalance,
        "bootstrap",
        timestamp,
      );
    }
  }

  private accountBalance(agentId: string): number {
    const row = this.getAccountStmt.get(agentId) as AccountRow | null;
    return row?.balance ?? 0;
  }

  private addBalance(agentId: string, amount: number): void {
    this.updateAccountBalanceStmt.run(amount, nowIso(), agentId);
  }

  private availableFor(agentId: string): number {
    return this.accountBalance(agentId) - this.reservedFor(agentId);
  }

  private reservedFor(agentId: string): number {
    const row = this.getReservedStmt.get(agentId, nowIso()) as { reserved: number } | null;
    return row?.reserved ?? 0;
  }

  private getReservation(reservationId: string): ReservationRow | undefined {
    const row = this.getReservationStmt.get(reservationId) as ReservationRow | null;
    return row ?? undefined;
  }

  private getTransfer(transferId: string): TransferRow | undefined {
    const row = this.getTransferStmt.get(transferId) as TransferRow | null;
    return row ?? undefined;
  }

  private bootstrapBalanceFor(agentId: string): number {
    if (agentId === FRONTIER_REWARD_TREASURY_AGENT_ID) {
      return this.rewardTreasuryBalance;
    }
    return this.initialBalance;
  }
}

function rowToReservation(row: ReservationRow): Reservation {
  return {
    reservationId: row.reservation_id,
    amount: row.amount,
    expiresAt: row.expires_at,
  };
}

function validatePositiveInteger(amount: number, operation: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new PaymentError({
      operation,
      message: `Amount must be a positive integer, got ${amount}`,
    });
  }
}

function resolveNonNegativeIntegerOption(
  optionValue: number | undefined,
  envName: string,
  defaultValue: number,
): number {
  if (optionValue !== undefined) {
    validateNonNegativeInteger(optionValue, envName);
    return optionValue;
  }
  const envValue = process.env[envName];
  if (envValue === undefined || envValue === "") {
    return defaultValue;
  }
  const parsed = Number(envValue);
  validateNonNegativeInteger(parsed, envName);
  return parsed;
}

function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new PaymentError({
      operation: "credits.bootstrap",
      message: `${name} must be a non-negative integer, got ${value}`,
    });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
