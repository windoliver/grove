/**
 * Session isolation tests for SqliteHandoffStore.
 *
 * Two stores sharing the same DB but scoped to different sessions must
 * not see, expire, or mutate each other's handoffs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DeadlineWatcher } from "../core/deadline-watcher.js";
import { HandoffStatus } from "../core/handoff.js";
import { LocalEventBus } from "../core/local-event-bus.js";
import { SqliteHandoffStore } from "./sqlite-handoff-store.js";
import { initSqliteDb } from "./sqlite-store.js";

describe("SqliteHandoffStore session scoping", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-handoff-session-"));
    dbPath = join(tempDir, "test.db");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("scoped stores see only their own session's handoffs", async () => {
    const db = initSqliteDb(dbPath);
    const storeA = new SqliteHandoffStore(db, "session-A");
    const storeB = new SqliteHandoffStore(db, "session-B");

    const hA = await storeA.create({
      sourceCid: "blake3:a",
      fromRole: "coder",
      toRole: "reviewer",
    });
    const hB = await storeB.create({
      sourceCid: "blake3:b",
      fromRole: "coder",
      toRole: "reviewer",
    });

    const listA = await storeA.list();
    const listB = await storeB.list();

    expect(listA).toHaveLength(1);
    expect(listA[0]?.handoffId).toBe(hA.handoffId);
    expect(listB).toHaveLength(1);
    expect(listB[0]?.handoffId).toBe(hB.handoffId);

    // get() must not leak across sessions either
    expect(await storeA.get(hB.handoffId)).toBeUndefined();
    expect(await storeB.get(hA.handoffId)).toBeUndefined();

    db.close();
  });

  test("expireStale in session A does not flip session B's overdue handoffs", async () => {
    const db = initSqliteDb(dbPath);
    const storeA = new SqliteHandoffStore(db, "session-A");
    const storeB = new SqliteHandoffStore(db, "session-B");

    const pastDeadline = new Date(Date.now() - 60_000).toISOString();

    const hA = await storeA.create({
      sourceCid: "blake3:a",
      fromRole: "coder",
      toRole: "reviewer",
      replyDueAt: pastDeadline,
    });
    const hB = await storeB.create({
      sourceCid: "blake3:b",
      fromRole: "coder",
      toRole: "reviewer",
      replyDueAt: pastDeadline,
    });

    // Session A's watcher expires only session A's row
    const expiredByA = await storeA.expireStale();
    expect(expiredByA.map((h) => h.handoffId)).toEqual([hA.handoffId]);

    // Session B's handoff should still be unresolved — NOT flipped by A
    const bRow = await storeB.get(hB.handoffId);
    expect(bRow?.status).toBe(HandoffStatus.PendingPickup);

    db.close();
  });

  test("isInCurrentSession rejects cross-session handoff ids", async () => {
    const db = initSqliteDb(dbPath);
    const storeA = new SqliteHandoffStore(db, "session-A");
    const storeB = new SqliteHandoffStore(db, "session-B");

    const hA = await storeA.create({
      sourceCid: "blake3:a",
      fromRole: "coder",
      toRole: "reviewer",
    });

    // Session A owns it
    expect(await storeA.isInCurrentSession?.(hA.handoffId)).toBe(true);
    // Session B does not
    expect(await storeB.isInCurrentSession?.(hA.handoffId)).toBe(false);
    // Nonexistent handoff returns false
    expect(await storeA.isInCurrentSession?.("nonexistent")).toBe(false);

    db.close();
  });

  test("markReplied in session A cannot resolve session B's handoff", async () => {
    const db = initSqliteDb(dbPath);
    const storeA = new SqliteHandoffStore(db, "session-A");
    const storeB = new SqliteHandoffStore(db, "session-B");

    const hB = await storeB.create({
      sourceCid: "blake3:b",
      fromRole: "coder",
      toRole: "reviewer",
    });

    // Session A tries to resolve B's handoff — should fail with NotFound
    // (scoped get() returns undefined, so scoped mark* treats it as missing).
    await expect(storeA.markReplied(hB.handoffId, "blake3:reply")).rejects.toThrow();

    // B's handoff should be unaffected
    const bRow = await storeB.get(hB.handoffId);
    expect(bRow?.status).toBe(HandoffStatus.PendingPickup);
    expect(bRow?.resolvedByCid).toBeUndefined();

    db.close();
  });

  test("unscoped store (no sessionId) does not expose session capability methods", () => {
    const db = initSqliteDb(dbPath);
    const unscoped = new SqliteHandoffStore(db);

    expect(unscoped.listForCurrentSession).toBeUndefined();
    expect(unscoped.isInCurrentSession).toBeUndefined();

    db.close();
  });

  test("scoped store exposes session capability methods", () => {
    const db = initSqliteDb(dbPath);
    const scoped = new SqliteHandoffStore(db, "session-X");

    expect(typeof scoped.listForCurrentSession).toBe("function");
    expect(typeof scoped.isInCurrentSession).toBe("function");

    db.close();
  });

  test("DeadlineWatcher rebuild is session-scoped — does not arm peer timers", async () => {
    const db = initSqliteDb(dbPath);
    const storeA = new SqliteHandoffStore(db, "session-A");
    const storeB = new SqliteHandoffStore(db, "session-B");
    const bus = new LocalEventBus();

    // Both sessions have unresolved handoffs with future deadlines
    await storeA.create({
      sourceCid: "blake3:a",
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
      replyDueAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await storeB.create({
      sourceCid: "blake3:b",
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
      replyDueAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // A watcher scoped to session A must arm exactly ONE timer (for A's row)
    const watcherA = new DeadlineWatcher({ handoffStore: storeA, eventBus: bus });
    const countA = await watcherA.rebuildFromStore();
    expect(countA).toBe(1);
    expect(watcherA.activeCount).toBe(1);

    watcherA.close();
    bus.close();
    db.close();
  });

  test("pre-#164 NULL-session rows are visible to scoped sessions (migration shim)", async () => {
    const db = initSqliteDb(dbPath);
    // Simulate a legacy row by inserting with session_id=NULL via unscoped store
    const legacy = new SqliteHandoffStore(db);
    const hLegacy = await legacy.create({
      sourceCid: "blake3:legacy",
      fromRole: "coder",
      toRole: "reviewer",
    });

    // Scoped sessions MUST still see NULL-session rows after upgrade so
    // in-flight pre-#164 handoffs don't strand the coder→reviewer loop.
    const scoped = new SqliteHandoffStore(db, "new-session");
    const list = await scoped.list();
    expect(list.find((h) => h.handoffId === hLegacy.handoffId)).toBeDefined();

    // Unscoped stores still see legacy rows (for CLI/admin paths)
    const legacyList = await legacy.list();
    expect(legacyList.find((h) => h.handoffId === hLegacy.handoffId)).toBeDefined();

    db.close();
  });

  test("isInCurrentSession honors the NULL-session migration shim", async () => {
    const db = initSqliteDb(dbPath);
    // Legacy row with session_id=NULL (pre-#164)
    const legacy = new SqliteHandoffStore(db);
    const hLegacy = await legacy.create({
      sourceCid: "blake3:legacy",
      fromRole: "coder",
      toRole: "reviewer",
    });

    const scoped = new SqliteHandoffStore(db, "active-session");
    // Without the shim, receipt tools would find the legacy row via get()
    // but reject it in isInCurrentSession, stranding it post-upgrade.
    expect(await scoped.isInCurrentSession?.(hLegacy.handoffId)).toBe(true);

    db.close();
  });

  test("legacy NULL-session rows do NOT leak between scoped sessions (only the first resolver wins)", async () => {
    const db = initSqliteDb(dbPath);
    // Pre-#164 row with session_id=NULL
    const legacy = new SqliteHandoffStore(db);
    const hLegacy = await legacy.create({
      sourceCid: "blake3:legacy",
      fromRole: "coder",
      toRole: "reviewer",
    });

    // Two scoped sessions both see the legacy row (migration shim)
    const storeA = new SqliteHandoffStore(db, "session-A");
    const storeB = new SqliteHandoffStore(db, "session-B");

    const listA = await storeA.list();
    const listB = await storeB.list();
    expect(listA.find((h) => h.handoffId === hLegacy.handoffId)).toBeDefined();
    expect(listB.find((h) => h.handoffId === hLegacy.handoffId)).toBeDefined();

    // Scoped mark* operations work on legacy rows (pending_pickup → delivered)
    await storeA.markDelivered(hLegacy.handoffId);
    const afterA = await storeA.get(hLegacy.handoffId);
    expect(afterA?.status).toBe(HandoffStatus.Delivered);

    db.close();
  });
});
