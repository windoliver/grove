import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCreditsServiceTests } from "../core/credits.conformance.js";
import { SqliteCreditsService } from "./sqlite-credits-service.js";
import { initSqliteDb } from "./sqlite-store.js";

interface CreditTransferRow {
  readonly transfer_id: string;
  readonly from_agent_id: string;
  readonly to_agent_id: string;
  readonly amount: number;
  readonly transfer_type: string;
}

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
      if (amount === 0) return;
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
    try {
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
    } finally {
      firstDb.close();
    }

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

  test("persists pending reservations after reopen", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-sqlite-credits-pending-"));
    const dbPath = join(tempDir, "credits.db");

    const firstDb = initSqliteDb(dbPath);
    const first = new SqliteCreditsService(firstDb, {
      initialBalance: 0,
      rewardTreasuryBalance: 0,
    });
    try {
      first.seed("creator", 500);
      await first.reserve({
        reservationId: "res-pending",
        agentId: "creator",
        amount: 125,
        timeoutMs: 60_000,
      });
    } finally {
      firstDb.close();
    }

    const secondDb = initSqliteDb(dbPath);
    const second = new SqliteCreditsService(secondDb, {
      initialBalance: 0,
      rewardTreasuryBalance: 0,
    });
    try {
      expect(await second.balance("creator")).toEqual({
        available: 375,
        reserved: 125,
        total: 500,
      });
      await second.capture("res-pending");
      expect(await second.balance("creator")).toEqual({
        available: 375,
        reserved: 0,
        total: 375,
      });
    } finally {
      secondDb.close();
    }
  });

  test("capture transfer id collision rolls back balances and reservation state", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-sqlite-credits-capture-collision-"));
    const db = initSqliteDb(join(tempDir, "credits.db"));
    const service = new SqliteCreditsService(db, {
      initialBalance: 0,
      rewardTreasuryBalance: 0,
    });

    try {
      service.seed("creator", 500);
      await service.reserve({
        reservationId: "res-collision",
        agentId: "creator",
        amount: 125,
        timeoutMs: 60_000,
      });
      db.prepare(
        `INSERT INTO credit_transfers
          (transfer_id, from_agent_id, to_agent_id, amount, transfer_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "capture:res-collision",
        "other-agent",
        "other-recipient",
        1,
        "transfer",
        new Date().toISOString(),
      );

      await expect(service.capture("res-collision", { toAgentId: "worker" })).rejects.toThrow();

      expect(await service.balance("creator")).toEqual({
        available: 375,
        reserved: 125,
        total: 500,
      });
      expect(await service.balance("worker")).toEqual({
        available: 0,
        reserved: 0,
        total: 0,
      });
      const reservation = db
        .prepare(
          "SELECT status, captured_to_agent_id FROM credit_reservations WHERE reservation_id = ?",
        )
        .get("res-collision") as {
        readonly status: string;
        readonly captured_to_agent_id: string | null;
      };
      expect(reservation).toEqual({
        status: "pending",
        captured_to_agent_id: null,
      });
    } finally {
      db.close();
    }
  });

  test("two service instances sharing one database cannot overdraw reservations", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-sqlite-credits-contention-"));
    const dbPath = join(tempDir, "credits.db");
    const dbA = initSqliteDb(dbPath);
    const dbB = initSqliteDb(dbPath);
    const a = new SqliteCreditsService(dbA, {
      initialBalance: 0,
      rewardTreasuryBalance: 0,
    });
    const b = new SqliteCreditsService(dbB, {
      initialBalance: 0,
      rewardTreasuryBalance: 0,
    });

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
      expect(await b.balance("agent-1")).toEqual({
        available: 20,
        reserved: 80,
        total: 100,
      });
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

    try {
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
      const bootstrapRows = db
        .prepare(
          `SELECT transfer_id, from_agent_id, to_agent_id, amount, transfer_type
           FROM credit_transfers
           WHERE transfer_id IN ('bootstrap:new-agent', 'bootstrap:system:frontier-rewards')
           ORDER BY transfer_id`,
        )
        .all() as readonly CreditTransferRow[];
      expect(bootstrapRows).toEqual([
        {
          transfer_id: "bootstrap:new-agent",
          from_agent_id: "system:bootstrap",
          to_agent_id: "new-agent",
          amount: 10000,
          transfer_type: "bootstrap",
        },
        {
          transfer_id: "bootstrap:system:frontier-rewards",
          from_agent_id: "system:bootstrap",
          to_agent_id: "system:frontier-rewards",
          amount: 1000000,
          transfer_type: "bootstrap",
        },
      ]);
    } finally {
      db.close();
    }

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
      const row = reopened.prepare("SELECT COUNT(*) AS count FROM credit_transfers").get() as {
        readonly count: number;
      };
      expect(row.count).toBe(2);
    } finally {
      reopened.close();
    }
  });
});
