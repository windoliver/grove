# Production Credits Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable SQLite-backed `CreditsService`, wire it into server and MCP runtimes, restore escrowed settlement recovery, and add one idempotent frontier-advance reward signal.

**Architecture:** Add a local `SqliteCreditsService` behind the existing `CreditsService` protocol and instantiate it from `createLocalRuntime()`. Runtime entry points pass the same service to operation deps and `SettlementSweep`. A focused frontier reward service runs after contribution commits and uses deterministic reward IDs plus `BountyStore.recordReward` for exactly-once payment.

**Tech Stack:** Bun 1.3.x, `bun:test`, TypeScript strict mode, `bun:sqlite`, existing Grove stores and operation adapters.

---

## File Structure

- Create `src/local/sqlite-credits-service.ts`: SQLite DDL, bootstrap configuration, durable `CreditsService` implementation, and test-only `seed()` helper.
- Create `src/local/sqlite-credits-service.test.ts`: conformance, persistence, bootstrap, and cross-process contention tests.
- Create `src/core/credits-constants.ts`: shared credits defaults that are pure and safe for core/local imports.
- Create `src/core/frontier-reward-service.ts`: reward detection and transfer orchestration.
- Create `src/core/frontier-reward-service.test.ts`: frontier-advance reward and idempotency tests.
- Modify `src/local/sqlite-store.ts`: execute credits DDL during DB initialization and include credits service in the store factory.
- Modify `src/local/runtime.ts`: construct and expose `creditsService` and `frontierRewardService`.
- Modify `src/local/index.ts` and `src/core/index.ts`: export the new public local/core classes and types.
- Modify `src/core/operations/deps.ts`: add optional `frontierRewardService`.
- Modify `src/core/operations/contribute.ts`: call the reward service after a new contribution commit and after frontier cache invalidation.
- Modify `src/server/deps.ts` and `src/server/operation-adapter.ts`: forward `creditsService`, `bountyStore`, and `frontierRewardService` into operations.
- Modify `src/mcp/deps.ts` and `src/mcp/operation-adapter.ts`: forward `frontierRewardService`.
- Modify `src/server/serve.ts`, `src/mcp/serve.ts`, and `src/mcp/serve-http.ts`: pass `creditsService` and `frontierRewardService` through runtime deps and sweep construction.
- Modify `src/local/runtime.test.ts`, `src/mcp/deps-parity.test.ts`, `src/server/watch-wiring.test.ts`, and `src/core/sweep-reconciler.test.ts`: verify runtime exposure, adapter forwarding, and escrowed settlement recovery.

### Task 1: SQLite Credits Tests

**Files:**
- Create: `src/local/sqlite-credits-service.test.ts`
- Modify after red: `src/local/sqlite-credits-service.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCreditsServiceTests } from "../core/credits.conformance.js";
import { initSqliteDb } from "./sqlite-store.js";
import { SqliteCreditsService } from "./sqlite-credits-service.js";

runCreditsServiceTests(async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "grove-sqlite-credits-"));
  const db = initSqliteDb(join(tempDir, "credits.db"));
  const service = new SqliteCreditsService(db, {
    initialBalance: 0,
    rewardTreasuryBalance: 0,
  });

  return {
    service,
    seedBalance: async (agentId: string, amount: number) => {
      service.seed(agentId, amount);
    },
    cleanup: async () => {
      db.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
});

describe("SqliteCreditsService persistence", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("persists balances, reservations, captures, and transfers after reopen", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-sqlite-credits-persist-"));
    const dbPath = join(tempDir, "credits.db");

    const firstDb = initSqliteDb(dbPath);
    const first = new SqliteCreditsService(firstDb, {
      initialBalance: 0,
      rewardTreasuryBalance: 0,
    });
    first.seed("creator", 500);
    await first.reserve({
      reservationId: "res-persist",
      agentId: "creator",
      amount: 125,
      timeoutMs: 60_000,
    });
    await first.capture("res-persist", { toAgentId: "worker" });
    await first.transfer({
      transferId: "xfer-persist",
      fromAgentId: "worker",
      toAgentId: "reviewer",
      amount: 25,
    });
    firstDb.close();

    const secondDb = initSqliteDb(dbPath);
    const second = new SqliteCreditsService(secondDb, {
      initialBalance: 0,
      rewardTreasuryBalance: 0,
    });
    try {
      expect(await second.balance("creator")).toEqual({
        available: 375,
        reserved: 0,
        total: 375,
      });
      expect(await second.balance("worker")).toEqual({
        available: 100,
        reserved: 0,
        total: 100,
      });
      expect(await second.balance("reviewer")).toEqual({
        available: 25,
        reserved: 0,
        total: 25,
      });
      await second.capture("res-persist", { toAgentId: "worker" });
      await second.transfer({
        transferId: "xfer-persist",
        fromAgentId: "worker",
        toAgentId: "reviewer",
        amount: 25,
      });
      expect(await second.balance("worker")).toEqual({
        available: 100,
        reserved: 0,
        total: 100,
      });
    } finally {
      secondDb.close();
    }
  });

  test("two service instances sharing one database cannot overdraw reservations", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-sqlite-credits-contention-"));
    const dbPath = join(tempDir, "credits.db");
    const dbA = initSqliteDb(dbPath);
    const dbB = initSqliteDb(dbPath);
    const a = new SqliteCreditsService(dbA, { initialBalance: 0, rewardTreasuryBalance: 0 });
    const b = new SqliteCreditsService(dbB, { initialBalance: 0, rewardTreasuryBalance: 0 });

    try {
      a.seed("agent-1", 100);
      await a.reserve({
        reservationId: "res-a",
        agentId: "agent-1",
        amount: 80,
        timeoutMs: 60_000,
      });
      await expect(
        b.reserve({
          reservationId: "res-b",
          agentId: "agent-1",
          amount: 80,
          timeoutMs: 60_000,
        }),
      ).rejects.toThrow(/insufficient/i);
      expect(await b.balance("agent-1")).toEqual({ available: 20, reserved: 80, total: 100 });
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  test("default bootstrap grants are durable and can be disabled", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-sqlite-credits-bootstrap-"));
    const dbPath = join(tempDir, "credits.db");
    const db = initSqliteDb(dbPath);
    const service = new SqliteCreditsService(db);

    expect(await service.balance("new-agent")).toEqual({
      available: 10000,
      reserved: 0,
      total: 10000,
    });
    expect(await service.balance("system:frontier-rewards")).toEqual({
      available: 1000000,
      reserved: 0,
      total: 1000000,
    });
    db.close();

    const reopened = initSqliteDb(dbPath);
    const disabled = new SqliteCreditsService(reopened, {
      initialBalance: 0,
      rewardTreasuryBalance: 0,
    });
    try {
      expect(await disabled.balance("new-agent")).toEqual({
        available: 10000,
        reserved: 0,
        total: 10000,
      });
      expect(await disabled.balance("never-seen")).toEqual({
        available: 0,
        reserved: 0,
        total: 0,
      });
    } finally {
      reopened.close();
    }
  });
});
```

- [ ] **Step 2: Run the red test**

Run: `bun test src/local/sqlite-credits-service.test.ts`

Expected: FAIL with a module resolution error for `./sqlite-credits-service.js`.

- [ ] **Step 3: Commit the red test**

```bash
git add src/local/sqlite-credits-service.test.ts
git commit -m "test(local): cover sqlite credits service contract"
```

### Task 2: SQLite Credits Service

**Files:**
- Create: `src/core/credits-constants.ts`
- Create: `src/local/sqlite-credits-service.ts`
- Modify: `src/local/sqlite-store.ts`
- Modify: `src/local/index.ts`

- [ ] **Step 1: Add shared pure credits constants**

Create `src/core/credits-constants.ts`:

```typescript
export const FRONTIER_REWARD_TREASURY_AGENT_ID = "system:frontier-rewards";
export const DEFAULT_CREDITS_INITIAL_BALANCE = 10_000;
export const DEFAULT_CREDITS_REWARD_TREASURY_BALANCE = 1_000_000;
```

- [ ] **Step 2: Implement SQLite credits schema and service**

Create `src/local/sqlite-credits-service.ts` with these exported pieces:

```typescript
import type { Database } from "bun:sqlite";

import { InsufficientCreditsError, PaymentError } from "../core/bounty-errors.js";
import {
  DEFAULT_CREDITS_INITIAL_BALANCE,
  DEFAULT_CREDITS_REWARD_TREASURY_BALANCE,
  FRONTIER_REWARD_TREASURY_AGENT_ID,
} from "../core/credits-constants.js";
import type { CreditBalance, CreditsService, Reservation, TransferResult } from "../core/credits.js";

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

function nowUtcIso(): string {
  return new Date().toISOString();
}

function validatePositiveInteger(amount: number, operation: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new PaymentError({
      operation,
      message: `${operation} amount must be a positive integer, got ${amount}`,
    });
  }
}

function envInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export class SqliteCreditsService implements CreditsService {
  private readonly initialBalance: number;
  private readonly rewardTreasuryBalance: number;

  constructor(
    private readonly db: Database,
    options?: SqliteCreditsServiceOptions,
  ) {
    this.initialBalance =
      options?.initialBalance ?? envInteger("GROVE_CREDITS_INITIAL_BALANCE", DEFAULT_CREDITS_INITIAL_BALANCE);
    this.rewardTreasuryBalance =
      options?.rewardTreasuryBalance ??
      envInteger("GROVE_CREDITS_REWARD_TREASURY_BALANCE", DEFAULT_CREDITS_REWARD_TREASURY_BALANCE);
    this.db.exec(SQLITE_CREDITS_DDL);
  }

  seed(agentId: string, amount: number): void {
    validatePositiveInteger(amount, "seed");
    this.withImmediateTransaction(() => {
      this.ensureAccount(agentId, 0);
      this.adjustBalance(agentId, amount);
      this.insertTransfer(`seed:${agentId}:${crypto.randomUUID()}`, "system:seed", agentId, amount, "seed");
    });
  }

  async reserve(opts: {
    readonly reservationId: string;
    readonly agentId: string;
    readonly amount: number;
    readonly timeoutMs: number;
  }): Promise<Reservation> {
    validatePositiveInteger(opts.amount, "reserve");
    return this.withImmediateTransaction(() => {
      const existing = this.getReservation(opts.reservationId);
      if (existing !== undefined) {
        if (existing.agent_id !== opts.agentId || existing.amount !== opts.amount) {
          throw new PaymentError({
            operation: "reserve",
            message: `Reservation '${opts.reservationId}' already exists with different parameters`,
          });
        }
        return {
          reservationId: existing.reservation_id,
          amount: existing.amount,
          expiresAt: existing.expires_at,
        };
      }

      this.ensureAccount(opts.agentId, this.bootstrapAmountFor(opts.agentId));
      const available = this.balanceSync(opts.agentId).available;
      if (available < opts.amount) {
        throw new InsufficientCreditsError({ available, required: opts.amount });
      }

      const expiresAt = new Date(Date.now() + opts.timeoutMs).toISOString();
      const now = nowUtcIso();
      this.db
        .prepare(
          `INSERT INTO credit_reservations (
             reservation_id, agent_id, amount, expires_at, status,
             captured_to_agent_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        )
        .run(opts.reservationId, opts.agentId, opts.amount, expiresAt, now, now);
      return { reservationId: opts.reservationId, amount: opts.amount, expiresAt };
    });
  }

  async capture(reservationId: string, opts?: { toAgentId: string }): Promise<void> {
    this.withImmediateTransaction(() => {
      const reservation = this.getReservation(reservationId);
      if (reservation === undefined) {
        throw new PaymentError({ operation: "capture", message: `Reservation '${reservationId}' not found` });
      }
      if (reservation.status === "captured") {
        const requestedTo = opts?.toAgentId;
        const originalTo = reservation.captured_to_agent_id ?? undefined;
        if (requestedTo !== originalTo) {
          throw new PaymentError({
            operation: "capture",
            message: `Reservation '${reservationId}' already captured with different toAgentId`,
          });
        }
        return;
      }
      if (reservation.status === "voided") {
        throw new PaymentError({ operation: "capture", message: `Reservation '${reservationId}' already voided` });
      }
      if (new Date(reservation.expires_at).getTime() <= Date.now()) {
        throw new PaymentError({ operation: "capture", message: `Reservation '${reservationId}' has expired` });
      }

      this.adjustBalance(reservation.agent_id, -reservation.amount);
      if (opts?.toAgentId !== undefined) {
        this.ensureAccount(opts.toAgentId, this.bootstrapAmountFor(opts.toAgentId));
        this.adjustBalance(opts.toAgentId, reservation.amount);
      }
      this.db
        .prepare(
          `UPDATE credit_reservations
           SET status = 'captured', captured_to_agent_id = ?, updated_at = ?
           WHERE reservation_id = ?`,
        )
        .run(opts?.toAgentId ?? null, nowUtcIso(), reservationId);
      this.insertTransfer(
        `capture:${reservationId}`,
        reservation.agent_id,
        opts?.toAgentId ?? "system:captured",
        reservation.amount,
        "capture",
      );
    });
  }

  async void(reservationId: string): Promise<void> {
    this.withImmediateTransaction(() => {
      const reservation = this.getReservation(reservationId);
      if (
        reservation === undefined ||
        reservation.status === "captured" ||
        reservation.status === "voided"
      ) {
        return;
      }
      this.db
        .prepare("UPDATE credit_reservations SET status = 'voided', updated_at = ? WHERE reservation_id = ?")
        .run(nowUtcIso(), reservationId);
    });
  }

  async transfer(opts: {
    readonly transferId: string;
    readonly fromAgentId: string;
    readonly toAgentId: string;
    readonly amount: number;
  }): Promise<TransferResult> {
    validatePositiveInteger(opts.amount, "transfer");
    return this.withImmediateTransaction(() => {
      const existing = this.db
        .prepare("SELECT from_agent_id, to_agent_id, amount FROM credit_transfers WHERE transfer_id = ?")
        .get(opts.transferId) as TransferRow | null;
      if (existing !== null) {
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
          amount: opts.amount,
          fromAgentId: opts.fromAgentId,
          toAgentId: opts.toAgentId,
        };
      }

      this.ensureAccount(opts.fromAgentId, this.bootstrapAmountFor(opts.fromAgentId));
      this.ensureAccount(opts.toAgentId, this.bootstrapAmountFor(opts.toAgentId));
      const available = this.balanceSync(opts.fromAgentId).available;
      if (available < opts.amount) {
        throw new InsufficientCreditsError({ available, required: opts.amount });
      }
      if (opts.fromAgentId !== opts.toAgentId) {
        this.adjustBalance(opts.fromAgentId, -opts.amount);
        this.adjustBalance(opts.toAgentId, opts.amount);
      }
      this.insertTransfer(opts.transferId, opts.fromAgentId, opts.toAgentId, opts.amount, "transfer");
      return {
        transferId: opts.transferId,
        amount: opts.amount,
        fromAgentId: opts.fromAgentId,
        toAgentId: opts.toAgentId,
      };
    });
  }

  async balance(agentId: string): Promise<CreditBalance> {
    return this.withImmediateTransaction(() => {
      this.ensureAccount(agentId, this.bootstrapAmountFor(agentId));
      return this.balanceSync(agentId);
    });
  }

  close(): void {
    // Database ownership belongs to createSqliteStores/createLocalRuntime.
  }

  private bootstrapAmountFor(agentId: string): number {
    return agentId === FRONTIER_REWARD_TREASURY_AGENT_ID
      ? this.rewardTreasuryBalance
      : this.initialBalance;
  }

  private withImmediateTransaction<T>(fn: () => T): T {
    this.db.run("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.run("COMMIT");
      return result;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  private getReservation(reservationId: string): ReservationRow | undefined {
    const row = this.db
      .prepare(
        `SELECT reservation_id, agent_id, amount, expires_at, status, captured_to_agent_id
         FROM credit_reservations WHERE reservation_id = ?`,
      )
      .get(reservationId) as ReservationRow | null;
    return row ?? undefined;
  }

  private ensureAccount(agentId: string, bootstrapAmount: number): void {
    const row = this.db.prepare("SELECT balance FROM credit_accounts WHERE agent_id = ?").get(agentId) as AccountRow | null;
    if (row !== null) return;
    const now = nowUtcIso();
    this.db
      .prepare("INSERT INTO credit_accounts (agent_id, balance, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(agentId, bootstrapAmount, now, now);
    if (bootstrapAmount > 0) {
      this.insertTransfer(`bootstrap:${agentId}`, "system:bootstrap", agentId, bootstrapAmount, "bootstrap");
    }
  }

  private adjustBalance(agentId: string, delta: number): void {
    this.db
      .prepare("UPDATE credit_accounts SET balance = balance + ?, updated_at = ? WHERE agent_id = ?")
      .run(delta, nowUtcIso(), agentId);
  }

  private balanceSync(agentId: string): CreditBalance {
    const account = this.db.prepare("SELECT balance FROM credit_accounts WHERE agent_id = ?").get(agentId) as AccountRow | null;
    const total = account?.balance ?? 0;
    const reservedRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS reserved
         FROM credit_reservations
         WHERE agent_id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .get(agentId, nowUtcIso()) as { readonly reserved: number } | null;
    const reserved = reservedRow?.reserved ?? 0;
    return { available: total - reserved, reserved, total };
  }

  private insertTransfer(
    transferId: string,
    fromAgentId: string,
    toAgentId: string,
    amount: number,
    transferType: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO credit_transfers (
           transfer_id, from_agent_id, to_agent_id, amount, transfer_type, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(transferId, fromAgentId, toAgentId, amount, transferType, nowUtcIso());
  }
}
```

- [ ] **Step 3: Wire the schema into SQLite initialization**

Modify `src/local/sqlite-store.ts`:

```typescript
import { SQLITE_CREDITS_DDL, SqliteCreditsService } from "./sqlite-credits-service.js";
```

Inside `initSqliteDb()` after `db.exec(HANDOFF_DDL);`, add:

```typescript
db.exec(SQLITE_CREDITS_DDL);
```

In the `createSqliteStores()` return type, add:

```typescript
creditsService: SqliteCreditsService;
```

In the returned object, add:

```typescript
creditsService: new SqliteCreditsService(db),
```

- [ ] **Step 4: Export the local service**

Modify `src/local/index.ts`:

```typescript
export {
  SQLITE_CREDITS_DDL,
  SqliteCreditsService,
  type SqliteCreditsServiceOptions,
} from "./sqlite-credits-service.js";
```

- [ ] **Step 5: Export shared credits constants**

Modify `src/core/index.ts`:

```typescript
export {
  DEFAULT_CREDITS_INITIAL_BALANCE,
  DEFAULT_CREDITS_REWARD_TREASURY_BALANCE,
  FRONTIER_REWARD_TREASURY_AGENT_ID,
} from "./credits-constants.js";
```

- [ ] **Step 6: Run the green test**

Run: `bun test src/local/sqlite-credits-service.test.ts`

Expected: PASS for conformance, persistence, contention, and bootstrap tests.

- [ ] **Step 7: Commit**

```bash
git add src/core/credits-constants.ts src/core/index.ts src/local/sqlite-credits-service.ts src/local/sqlite-store.ts src/local/index.ts src/local/sqlite-credits-service.test.ts
git commit -m "feat(local): add durable sqlite credits service"
```

### Task 3: Local Runtime Exposure

**Files:**
- Modify: `src/local/runtime.ts`
- Modify: `src/local/runtime.test.ts`

- [ ] **Step 1: Add failing runtime tests**

Append to `src/local/runtime.test.ts`:

```typescript
test("provides durable creditsService from the local runtime", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "grove-runtime-credits-"));
  const groveDir = join(rootDir, ".grove");
  try {
    await mkdir(groveDir, { recursive: true });
    const runtime = createLocalRuntime({ groveDir, parseContract: false });
    try {
      await runtime.creditsService.transfer({
        transferId: "runtime-xfer",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        amount: 50,
      });
    } finally {
      runtime.close();
    }

    const reopened = createLocalRuntime({ groveDir, parseContract: false });
    try {
      expect(await reopened.creditsService.balance("agent-a")).toEqual({
        available: 9950,
        reserved: 0,
        total: 9950,
      });
      expect(await reopened.creditsService.balance("agent-b")).toEqual({
        available: 10050,
        reserved: 0,
        total: 10050,
      });
    } finally {
      reopened.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the red runtime test**

Run: `bun test src/local/runtime.test.ts`

Expected: FAIL because `LocalRuntime` does not expose `creditsService`.

- [ ] **Step 3: Add `creditsService` to LocalRuntime**

Modify imports in `src/local/runtime.ts`:

```typescript
import type { CreditsService } from "../core/credits.js";
```

Add to `LocalRuntime`:

```typescript
readonly creditsService: CreditsService;
```

Add to the returned object:

```typescript
creditsService: stores.creditsService,
```

The existing `stores.close()` will own the database close. Do not close the
credits service separately because `SqliteCreditsService.close()` is a no-op.

- [ ] **Step 4: Run the green runtime test**

Run: `bun test src/local/runtime.test.ts src/local/sqlite-credits-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/local/runtime.ts src/local/runtime.test.ts
git commit -m "feat(local): expose credits service from runtime"
```

### Task 4: Runtime Dependency Wiring

**Files:**
- Modify: `src/server/deps.ts`
- Modify: `src/server/operation-adapter.ts`
- Modify: `src/server/watch-wiring.test.ts`
- Modify: `src/server/serve.ts`
- Modify: `src/mcp/deps.ts`
- Modify: `src/mcp/deps-parity.test.ts`
- Modify: `src/mcp/serve.ts`
- Modify: `src/mcp/serve-http.ts`

- [ ] **Step 1: Add failing adapter and parity tests**

In `src/server/watch-wiring.test.ts`, add an assertion to the existing adapter test:

```typescript
const creditsService = { close: () => undefined } as unknown as NonNullable<
  ServerDeps["creditsService"]
>;
const bountyStore = { close: () => undefined } as unknown as NonNullable<
  ServerDeps["bountyStore"]
>;
const opDepsWithCredits = toOperationDeps({ ...deps, creditsService, bountyStore });
expect(opDepsWithCredits.creditsService).toBe(creditsService);
expect(opDepsWithCredits.bountyStore).toBe(bountyStore);
```

Add `import type { ServerDeps } from "./deps.js";` at the top of that test file.

In `src/mcp/deps-parity.test.ts`, add:

```typescript
test("LocalRuntime always provides creditsService", () => {
  expect(runtime.creditsService).toBeDefined();
});
```

Add `creditsService: runtime.creditsService` to both mirrored `McpDeps` objects
and assert:

```typescript
expect(deps.creditsService).toBe(runtime.creditsService);
```

- [ ] **Step 2: Run red wiring tests**

Run: `bun test src/server/watch-wiring.test.ts src/mcp/deps-parity.test.ts`

Expected: FAIL because `ServerDeps` and mirrored deps do not consistently expose
or forward `creditsService`.

- [ ] **Step 3: Update dependency interfaces and adapters**

In `src/server/deps.ts`, import the type:

```typescript
import type { CreditsService } from "../core/credits.js";
```

Add to `ServerDeps`:

```typescript
/** Optional credits service for bounty escrow and reward transfers. */
readonly creditsService?: CreditsService | undefined;
```

In `src/server/operation-adapter.ts`, add to the returned object:

```typescript
...(deps.bountyStore !== undefined ? { bountyStore: deps.bountyStore } : {}),
...(deps.creditsService !== undefined ? { creditsService: deps.creditsService } : {}),
```

In `src/mcp/deps.ts`, keep the existing `creditsService` field because it is
the same type as `ServerDeps.creditsService`.

- [ ] **Step 4: Wire runtime entry points**

In `src/server/serve.ts`, add to `deps`:

```typescript
creditsService: runtime.creditsService,
```

Replace the `SettlementSweep` registration with:

```typescript
sweepReconciler.register(new SettlementSweep(serverBountyStore, runtime.creditsService));
```

In `src/mcp/serve.ts`, add to the `deps` object:

```typescript
creditsService: runtime.creditsService,
```

In `src/mcp/serve-http.ts`, register the sweep with credits:

```typescript
httpSweepReconciler.register(new SettlementSweep(reconcilerBountyStore, runtime.creditsService));
```

Add to each scoped `McpDeps` object:

```typescript
creditsService: runtime.creditsService,
```

- [ ] **Step 5: Run green wiring tests**

Run: `bun test src/server/watch-wiring.test.ts src/mcp/deps-parity.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/deps.ts src/server/operation-adapter.ts src/server/watch-wiring.test.ts src/server/serve.ts src/mcp/deps.ts src/mcp/deps-parity.test.ts src/mcp/serve.ts src/mcp/serve-http.ts
git commit -m "feat(runtime): wire durable credits service"
```

### Task 5: Escrowed Settlement Recovery

**Files:**
- Modify: `src/core/sweep-reconciler.test.ts`

- [ ] **Step 1: Add failing restart recovery test**

Add imports:

```typescript
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalRuntime } from "../local/runtime.js";
import { makeContribution } from "./test-helpers.js";
```

Add this test in `describe("SettlementSweep", () => { ... })`:

```typescript
test("recovers escrowed pending_settlement bounties after runtime restart", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "grove-settlement-restart-"));
  const groveDir = join(rootDir, ".grove");
  try {
    await mkdir(groveDir, { recursive: true });
    const first = createLocalRuntime({
      groveDir,
      frontierCacheTtlMs: 0,
      workspace: false,
      parseContract: false,
    });
    let bountyId = "";
    try {
      const contribution = makeContribution({
        summary: "Restart-settlement fulfillment",
        agent: { agentId: "worker" },
      });
      await first.contributionStore.put(contribution);
      const created = await createBountyOperation(
        {
          title: "Restart settlement bounty",
          amount: 100,
          criteria: { description: "any work" },
          agent: { agentId: "creator" },
        },
        {
          contributionStore: first.contributionStore,
          claimStore: first.claimStore,
          bountyStore: first.bountyStore,
          creditsService: first.creditsService,
        },
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      bountyId = created.value.bountyId;
      const claimed = await claimBountyOperation(
        { bountyId, agent: { agentId: "worker" } },
        {
          claimStore: first.claimStore,
          bountyStore: first.bountyStore,
        },
      );
      expect(claimed.ok).toBe(true);
      await first.bountyStore.beginSettlement(bountyId, contribution.cid);
    } finally {
      first.close();
    }

    const second = createLocalRuntime({
      groveDir,
      frontierCacheTtlMs: 0,
      workspace: false,
      parseContract: false,
    });
    try {
      const sweep = new SettlementSweep(second.bountyStore, second.creditsService);
      const result = await sweep.sweep();
      expect(result.found).toBe(1);
      expect(result.repaired).toBe(1);
      expect(result.errors).toEqual([]);
      expect((await second.bountyStore.getBounty(bountyId))?.status).toBe("settled");
      expect(await second.creditsService.balance("creator")).toEqual({
        available: 9900,
        reserved: 0,
        total: 9900,
      });
      expect(await second.creditsService.balance("worker")).toEqual({
        available: 10100,
        reserved: 0,
        total: 10100,
      });
    } finally {
      second.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the recovery test**

Run: `bun test src/core/sweep-reconciler.test.ts`

Expected: PASS after Tasks 2-4.

- [ ] **Step 3: Commit**

```bash
git add src/core/sweep-reconciler.test.ts
git commit -m "test(core): cover escrowed settlement recovery restart"
```

### Task 6: Frontier Reward Service

**Files:**
- Create: `src/core/frontier-reward-service.ts`
- Create: `src/core/frontier-reward-service.test.ts`
- Modify: `src/core/operations/deps.ts`
- Modify: `src/core/operations/contribute.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1: Write failing reward service tests**

Create `src/core/frontier-reward-service.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";

import { SqliteBountyStore } from "../local/sqlite-bounty-store.js";
import { SqliteCreditsService } from "../local/sqlite-credits-service.js";
import { initSqliteDb, SqliteContributionStore } from "../local/sqlite-store.js";
import { DefaultFrontierCalculator } from "./frontier.js";
import { FrontierRewardService } from "./frontier-reward-service.js";
import { makeContribution, makeScore } from "./test-helpers.js";

describe("FrontierRewardService", () => {
  let db: ReturnType<typeof initSqliteDb>;
  let contributionStore: SqliteContributionStore;
  let bountyStore: SqliteBountyStore;
  let creditsService: SqliteCreditsService;
  let rewardService: FrontierRewardService;

  beforeEach(() => {
    db = initSqliteDb(":memory:");
    contributionStore = new SqliteContributionStore(db);
    bountyStore = new SqliteBountyStore(db);
    creditsService = new SqliteCreditsService(db, {
      initialBalance: 0,
      rewardTreasuryBalance: 100,
    });
    rewardService = new FrontierRewardService({
      frontier: new DefaultFrontierCalculator(contributionStore),
      bountyStore,
      creditsService,
    });
  });

  test("pays and records one reward when a contribution advances a minimized metric", async () => {
    const previous = makeContribution({
      summary: "Previous best",
      agent: { agentId: "agent-old" },
      scores: { val_bpb: makeScore({ value: 0.95, direction: "minimize" }) },
    });
    await contributionStore.put(previous);

    const improved = makeContribution({
      summary: "Improved best",
      agent: { agentId: "agent-new" },
      scores: { val_bpb: makeScore({ value: 0.9, direction: "minimize" }) },
    });
    await contributionStore.put(improved);

    await rewardService.evaluateContribution(improved);
    expect(await creditsService.balance("agent-new")).toEqual({
      available: 1,
      reserved: 0,
      total: 1,
    });
    const rewards = await bountyStore.listRewards({
      rewardType: "frontier_advance",
      recipientAgentId: "agent-new",
      contributionCid: improved.cid,
    });
    expect(rewards.length).toBe(1);
    expect(rewards[0]?.amount).toBe(1);

    await rewardService.evaluateContribution(improved);
    expect((await bountyStore.listRewards({ contributionCid: improved.cid })).length).toBe(1);
    expect(await creditsService.balance("agent-new")).toEqual({
      available: 1,
      reserved: 0,
      total: 1,
    });
  });

  test("does not reward exploration or non-improving contributions", async () => {
    const previous = makeContribution({
      summary: "Previous best",
      scores: { score: makeScore({ value: 10, direction: "maximize" }) },
    });
    await contributionStore.put(previous);
    const weaker = makeContribution({
      summary: "Weaker",
      agent: { agentId: "agent-weaker" },
      scores: { score: makeScore({ value: 9, direction: "maximize" }) },
    });
    await contributionStore.put(weaker);
    await rewardService.evaluateContribution(weaker);
    expect(await bountyStore.listRewards({ contributionCid: weaker.cid })).toEqual([]);

    const exploration = makeContribution({
      mode: "exploration",
      agent: { agentId: "agent-explore" },
      scores: { score: makeScore({ value: 11, direction: "maximize" }) },
    });
    await contributionStore.put(exploration);
    await rewardService.evaluateContribution(exploration);
    expect(await bountyStore.listRewards({ contributionCid: exploration.cid })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run red reward tests**

Run: `bun test src/core/frontier-reward-service.test.ts`

Expected: FAIL because `frontier-reward-service.js` does not exist.

- [ ] **Step 3: Implement reward service**

Create `src/core/frontier-reward-service.ts`:

```typescript
import type { BountyStore } from "./bounty-store.js";
import { RewardType } from "./bounty.js";
import { computeRewardId } from "./bounty-logic.js";
import { FRONTIER_REWARD_TREASURY_AGENT_ID } from "./credits-constants.js";
import type { CreditsService } from "./credits.js";
import type { FrontierCalculator, FrontierEntry } from "./frontier.js";
import type { Contribution, Score } from "./models.js";
import { ContributionMode } from "./models.js";

export interface FrontierRewardServiceOptions {
  readonly frontier: FrontierCalculator;
  readonly bountyStore: BountyStore;
  readonly creditsService: CreditsService;
  readonly treasuryAgentId?: string | undefined;
}

export class FrontierRewardService {
  private readonly frontier: FrontierCalculator;
  private readonly bountyStore: BountyStore;
  private readonly creditsService: CreditsService;
  private readonly treasuryAgentId: string;

  constructor(options: FrontierRewardServiceOptions) {
    this.frontier = options.frontier;
    this.bountyStore = options.bountyStore;
    this.creditsService = options.creditsService;
    this.treasuryAgentId = options.treasuryAgentId ?? FRONTIER_REWARD_TREASURY_AGENT_ID;
  }

  async evaluateContribution(contribution: Contribution): Promise<void> {
    if (contribution.mode === ContributionMode.Exploration || contribution.context?.ephemeral === true) {
      return;
    }
    if (contribution.scores === undefined) return;

    const frontier = await this.frontier.compute({ limit: 50 });
    for (const [metric, score] of Object.entries(contribution.scores)) {
      const entries = frontier.byMetric[metric] ?? [];
      const self = entries.find((entry) => entry.cid === contribution.cid);
      if (self === undefined) continue;
      const previous = entries.find((entry) => entry.cid !== contribution.cid);
      const improvement = this.improvement(score, previous);
      if (improvement <= 0) continue;

      const rewardId = computeRewardId(
        RewardType.FrontierAdvance,
        `frontier:${metric}:${contribution.agent.agentId}`,
        contribution.cid,
      );
      if (await this.bountyStore.hasReward(rewardId)) continue;

      const amount = Math.max(1, Math.ceil(improvement));
      const transfer = await this.creditsService.transfer({
        transferId: `reward:${rewardId}`,
        fromAgentId: this.treasuryAgentId,
        toAgentId: contribution.agent.agentId,
        amount,
      });
      await this.bountyStore.recordReward({
        rewardId,
        rewardType: RewardType.FrontierAdvance,
        recipient: contribution.agent,
        amount,
        contributionCid: contribution.cid,
        transferId: transfer.transferId,
        createdAt: new Date().toISOString(),
      });
    }
  }

  private improvement(score: Score, previous: FrontierEntry | undefined): number {
    if (previous === undefined) return 1;
    return score.direction === "maximize"
      ? score.value - previous.value
      : previous.value - score.value;
  }
}
```

- [ ] **Step 4: Add operation dependency and post-commit call**

In `src/core/operations/deps.ts`, import:

```typescript
import type { FrontierRewardService } from "../frontier-reward-service.js";
```

Add to `OperationDeps`:

```typescript
/** Optional automatic reward evaluator invoked after new contribution commits. */
readonly frontierRewardService?: FrontierRewardService | undefined;
```

In `src/core/operations/contribute.ts`, inside the existing post-write callback
block after `deps.onContributionWrite?.();`, add:

```typescript
if (!existedBefore) {
  await deps.frontierRewardService?.evaluateContribution(contribution);
}
```

Because the surrounding function is already async, keep the callback block as a
regular `try` block and allow `await` inside it.

In `src/core/index.ts`, export:

```typescript
export { FrontierRewardService, type FrontierRewardServiceOptions } from "./frontier-reward-service.js";
```

- [ ] **Step 5: Run reward tests**

Run: `bun test src/core/frontier-reward-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/frontier-reward-service.ts src/core/frontier-reward-service.test.ts src/core/operations/deps.ts src/core/operations/contribute.ts src/core/index.ts
git commit -m "feat(core): reward frontier advances with credits"
```

### Task 7: Runtime Reward Wiring

**Files:**
- Modify: `src/local/runtime.ts`
- Modify: `src/local/runtime.test.ts`
- Modify: `src/server/deps.ts`
- Modify: `src/server/operation-adapter.ts`
- Modify: `src/mcp/deps.ts`
- Modify: `src/mcp/operation-adapter.ts`
- Modify: `src/server/serve.ts`
- Modify: `src/mcp/serve.ts`
- Modify: `src/mcp/serve-http.ts`

- [ ] **Step 1: Add failing runtime reward exposure test**

Append to `src/local/runtime.test.ts`:

```typescript
test("provides frontierRewardService from the local runtime", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "grove-runtime-rewards-"));
  const groveDir = join(rootDir, ".grove");
  try {
    await mkdir(groveDir, { recursive: true });
    const runtime = createLocalRuntime({ groveDir, parseContract: false });
    try {
      expect(runtime.frontierRewardService).toBeDefined();
    } finally {
      runtime.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run red runtime reward test**

Run: `bun test src/local/runtime.test.ts`

Expected: FAIL because `LocalRuntime` does not expose `frontierRewardService`.

- [ ] **Step 3: Expose and forward reward service**

In `src/local/runtime.ts`, import:

```typescript
import { FrontierRewardService } from "../core/frontier-reward-service.js";
```

Add to `LocalRuntime`:

```typescript
readonly frontierRewardService: FrontierRewardService;
```

After `frontier` is created, add:

```typescript
const frontierRewardService = new FrontierRewardService({
  frontier,
  bountyStore: stores.bountyStore,
  creditsService: stores.creditsService,
});
```

Add to the returned object:

```typescript
frontierRewardService,
```

In `src/server/deps.ts` and `src/mcp/deps.ts`, add an optional
`frontierRewardService` field with type `FrontierRewardService`.

In both operation adapters, forward:

```typescript
...(deps.frontierRewardService !== undefined
  ? { frontierRewardService: deps.frontierRewardService }
  : {}),
```

In `src/server/serve.ts`, `src/mcp/serve.ts`, and `src/mcp/serve-http.ts`, add:

```typescript
frontierRewardService: runtime.frontierRewardService,
```

to the constructed dependency objects.

- [ ] **Step 4: Run reward wiring tests**

Run: `bun test src/local/runtime.test.ts src/server/watch-wiring.test.ts src/mcp/deps-parity.test.ts`

Expected: PASS after adding mirrored assertions for `frontierRewardService` in
the server and MCP tests.

- [ ] **Step 5: Commit**

```bash
git add src/local/runtime.ts src/local/runtime.test.ts src/server/deps.ts src/server/operation-adapter.ts src/mcp/deps.ts src/mcp/operation-adapter.ts src/server/serve.ts src/mcp/serve.ts src/mcp/serve-http.ts src/server/watch-wiring.test.ts src/mcp/deps-parity.test.ts
git commit -m "feat(runtime): wire frontier reward service"
```

### Task 8: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused test suite**

Run:

```bash
bun test src/local/sqlite-credits-service.test.ts src/local/runtime.test.ts src/core/frontier-reward-service.test.ts src/core/sweep-reconciler.test.ts src/server/watch-wiring.test.ts src/mcp/deps-parity.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 3: Run lint/check**

Run: `bun run check`

Expected: PASS.

- [ ] **Step 4: Run full test suite if focused suite, typecheck, and check pass**

Run: `bun test`

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git diff --stat HEAD~8..HEAD
```

Expected: only files from this plan are changed across the task commits.
