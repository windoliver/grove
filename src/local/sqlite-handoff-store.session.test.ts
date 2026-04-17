/**
 * Session isolation tests for SqliteHandoffStore.
 *
 * Two stores sharing the same DB but scoped to different sessions must
 * not see, expire, or mutate each other's handoffs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  // ------------------------------------------------------------------
  // Legacy pre-#164 quarantine (Codex PR #258 round 4 finding)
  //
  // Pre-#164 rows have session_id=NULL. Before quarantine, the
  // scopeClause used `(session_id = ? OR session_id IS NULL)` — meaning
  // every scoped session could see, list, mutate, and expire those
  // rows, so a session B process could clobber session A's in-flight
  // legacy handoff. The fix: on SqliteHandoffStore construction, stamp
  // all NULL-session rows with a sentinel session_id so they no longer
  // match any real scoped query. Rows stay in the DB (non-destructive
  // — see round 3 feedback), just become invisible via scoped APIs.
  // ------------------------------------------------------------------

  test("pre-#164 NULL-session rows are quarantined on scoped store construction", async () => {
    const db = initSqliteDb(dbPath);
    // Simulate a pre-#164 row: unscoped store inserts session_id=NULL.
    const legacy = new SqliteHandoffStore(db);
    const hLegacy = await legacy.create({
      sourceCid: "blake3:legacy",
      fromRole: "coder",
      toRole: "reviewer",
    });

    // Constructing a scoped store triggers the quarantine migration,
    // stamping the NULL row with the sentinel session_id.
    const scoped = new SqliteHandoffStore(db, "new-session");

    // Scoped list/get MUST NOT surface quarantined rows — that would
    // re-introduce the cross-session leak.
    const list = await scoped.list();
    expect(list.find((h) => h.handoffId === hLegacy.handoffId)).toBeUndefined();
    expect(await scoped.get(hLegacy.handoffId)).toBeUndefined();

    // Unscoped stores still see the row (CLI / admin paths need it).
    const legacyList = await legacy.list();
    expect(legacyList.find((h) => h.handoffId === hLegacy.handoffId)).toBeDefined();

    db.close();
  });

  test("isInCurrentSession returns false for quarantined legacy rows", async () => {
    const db = initSqliteDb(dbPath);
    const legacy = new SqliteHandoffStore(db);
    const hLegacy = await legacy.create({
      sourceCid: "blake3:legacy",
      fromRole: "coder",
      toRole: "reviewer",
    });

    const scoped = new SqliteHandoffStore(db, "active-session");
    // Quarantined rows deliberately fail ownership — a scoped session
    // must not be able to claim them via receipt tools.
    expect(await scoped.isInCurrentSession?.(hLegacy.handoffId)).toBe(false);

    db.close();
  });

  test("legacy NULL-session rows are invisible to every scoped session", async () => {
    const db = initSqliteDb(dbPath);
    const legacy = new SqliteHandoffStore(db);
    const hLegacy = await legacy.create({
      sourceCid: "blake3:legacy",
      fromRole: "coder",
      toRole: "reviewer",
    });

    // Both scoped sessions trigger quarantine on construction; neither
    // should see the legacy row.
    const storeA = new SqliteHandoffStore(db, "session-A");
    const storeB = new SqliteHandoffStore(db, "session-B");

    const listA = await storeA.list();
    const listB = await storeB.list();
    expect(listA.find((h) => h.handoffId === hLegacy.handoffId)).toBeUndefined();
    expect(listB.find((h) => h.handoffId === hLegacy.handoffId)).toBeUndefined();

    // Scoped mutations also reject — the row is outside both scopes.
    await expect(storeA.markDelivered(hLegacy.handoffId)).rejects.toThrow();
    await expect(storeB.markDelivered(hLegacy.handoffId)).rejects.toThrow();

    // Row is preserved (non-destructive quarantine) and still visible
    // via an unscoped store.
    const legacyList = await legacy.list();
    expect(legacyList.find((h) => h.handoffId === hLegacy.handoffId)).toBeDefined();

    db.close();
  });

  test("expireStale does not flip quarantined legacy rows from scoped sessions", async () => {
    const db = initSqliteDb(dbPath);
    const legacy = new SqliteHandoffStore(db);
    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    const hLegacy = await legacy.create({
      sourceCid: "blake3:legacy",
      fromRole: "coder",
      toRole: "reviewer",
      replyDueAt: pastDeadline,
    });

    // Construction of any scoped store quarantines the NULL row.
    const storeA = new SqliteHandoffStore(db, "session-A");
    const storeB = new SqliteHandoffStore(db, "session-B");

    // Neither scoped expireStale touches the quarantined row.
    const expiredByA = await storeA.expireStale();
    const expiredByB = await storeB.expireStale();
    expect(expiredByA).toHaveLength(0);
    expect(expiredByB).toHaveLength(0);

    // Status preserved — round 3 feedback required non-destructive migration.
    const row = await legacy.get(hLegacy.handoffId);
    expect(row?.status).toBe(HandoffStatus.PendingPickup);

    db.close();
  });

  test("constructing a store with the quarantine sentinel sessionId is rejected", async () => {
    // Round 5 regression: without this guard, a caller could forge
    // `new SqliteHandoffStore(db, "__legacy_unowned__")` and read /
    // mutate every quarantined legacy row — defeating the quarantine.
    const db = initSqliteDb(dbPath);

    // Seed a legacy NULL-session row, then trigger quarantine via a
    // normal scoped store.
    const legacy = new SqliteHandoffStore(db);
    const hLegacy = await legacy.create({
      sourceCid: "blake3:legacy",
      fromRole: "coder",
      toRole: "reviewer",
    });
    new SqliteHandoffStore(db, "real-session"); // runs the NULL→sentinel UPDATE

    // Attempted forgery must throw at construction.
    expect(() => new SqliteHandoffStore(db, "__legacy_unowned__")).toThrow(/reserved sentinel/);

    // The quarantined row is still present but only accessible via an
    // unscoped store.
    const legacyList = await legacy.list();
    expect(legacyList.find((h) => h.handoffId === hLegacy.handoffId)).toBeDefined();

    db.close();
  });

  test("quarantine is idempotent under concurrent scoped store construction", async () => {
    const db = initSqliteDb(dbPath);
    const legacy = new SqliteHandoffStore(db);
    await legacy.create({
      sourceCid: "blake3:a",
      fromRole: "coder",
      toRole: "reviewer",
    });

    // Simulate two processes opening the DB back-to-back. Each runs the
    // NULL→sentinel UPDATE. Second run's WHERE clause finds 0 NULL rows
    // and is a no-op — must not throw.
    const s1 = new SqliteHandoffStore(db, "S1");
    const s2 = new SqliteHandoffStore(db, "S2");
    expect((await s1.list()).length).toBe(0);
    expect((await s2.list()).length).toBe(0);

    db.close();
  });
});
