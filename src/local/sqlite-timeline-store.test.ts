import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkBlock } from "../core/timeline.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "../core/timeline.js";
import { runTimelineStoreConformance } from "../core/timeline-store.conformance.js";
import type { TimelineEventInput } from "../core/timeline-store.js";
import { initSqliteDb } from "./sqlite-store.js";
import { SqliteTimelineStore } from "./sqlite-timeline-store.js";

async function tempDb(): Promise<{
  readonly dbPath: string;
  readonly cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "grove-sqlite-timeline-"));
  return {
    dbPath: join(dir, "timeline.db"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

runTimelineStoreConformance({
  name: "SqliteTimelineStore",
  async createStore() {
    const { dbPath, cleanup } = await tempDb();
    const db = initSqliteDb(dbPath);
    const store = new SqliteTimelineStore(db);
    return {
      store,
      close: () => {
        db.close();
        void cleanup();
      },
    };
  },
});

describe("SqliteTimelineStore schema", () => {
  test("creates the normalized timeline tables and indexes required by Task 3", async () => {
    const { dbPath, cleanup } = await tempDb();
    const db = initSqliteDb(dbPath);
    try {
      expect(columnNames(db, "work_blocks")).toEqual(
        expect.arrayContaining([
          "work_block_id",
          "session_id",
          "goal",
          "actor_id",
          "actor_json",
          "origin",
          "status",
          "started_at",
          "updated_at",
          "completed_at",
          "input_refs_json",
          "output_refs_json",
          "evidence_refs_json",
          "approval_refs_json",
          "contribution_cids_json",
          "artifact_hashes_json",
          "claim_ids_json",
          "cost_summary_json",
          "links_json",
          "context_json",
          "revision",
          "created_at",
        ]),
      );
      expect(indexNames(db, "work_blocks")).toContain("idx_work_blocks_session_status");

      expect(columnNames(db, "timeline_cursors")).toEqual(
        expect.arrayContaining(["scope", "current_rv"]),
      );

      expect(columnNames(db, "timeline_events")).toEqual(
        expect.arrayContaining([
          "event_id",
          "scope",
          "resource_version",
          "session_id",
          "type",
          "occurred_at",
          "recorded_at",
          "actor_id",
          "actor_json",
          "work_block_id",
          "target_refs_json",
          "payload_json",
        ]),
      );
      expect(indexNames(db, "timeline_events")).toEqual(
        expect.arrayContaining([
          "idx_timeline_events_scope_rv",
          "idx_timeline_events_work_block",
          "idx_timeline_events_type",
        ]),
      );
    } finally {
      db.close();
      await cleanup();
    }
  });
});

describe("SqliteTimelineStore persistence", () => {
  test("preserves optional links absence on minimal WorkBlock round-trip", async () => {
    const { dbPath, cleanup } = await tempDb();
    const db = initSqliteDb(dbPath);
    const store = new SqliteTimelineStore(db);
    try {
      const block = makeMinimalWorkBlock();

      await store.putWorkBlock(block);

      expect(await store.getWorkBlock(block.workBlockId)).toEqual(block);
    } finally {
      store.close();
      db.close();
      await cleanup();
    }
  });

  test("serializes concurrent work block patches without losing fields", async () => {
    const { dbPath, cleanup } = await tempDb();
    const db = initSqliteDb(dbPath);
    const store = new SqliteTimelineStore(db);
    try {
      const block = makeMinimalWorkBlock({ workBlockId: "wb-patch-race" });
      const outputRef = { kind: "Artifact", id: "artifact-1" };
      await store.putWorkBlock(block);

      await Promise.all([
        store.patchWorkBlock(block.workBlockId, { status: WorkBlockStatus.Running }),
        store.patchWorkBlock(block.workBlockId, { outputRefs: [outputRef] }),
      ]);

      const finalBlock = await store.getWorkBlock(block.workBlockId);
      expect(finalBlock?.revision).toBe(3);
      expect(finalBlock?.status).toBe(WorkBlockStatus.Running);
      expect(finalBlock?.outputRefs).toEqual([outputRef]);
    } finally {
      store.close();
      db.close();
      await cleanup();
    }
  });

  test("deduplicates repeated timeline event appends without advancing cursor or watch twice", async () => {
    const { dbPath, cleanup } = await tempDb();
    const db = initSqliteDb(dbPath);
    const store = new SqliteTimelineStore(db);
    let writes = 0;
    store.onTimelineEventWrite = () => {
      writes += 1;
    };
    try {
      const input = makeTimelineEventInput();

      const first = await store.appendTimelineEvent(input);
      const second = await store.appendTimelineEvent(input);

      expect(second).toEqual(first);
      expect(await store.currentTimelineResourceVersion(input.sessionId)).toBe("1");
      expect(writes).toBe(1);
    } finally {
      store.close();
      db.close();
      await cleanup();
    }
  });

  test("persists work blocks and session timeline cursors across database reopen", async () => {
    const { dbPath, cleanup } = await tempDb();
    try {
      const firstDb = initSqliteDb(dbPath);
      const firstStore = new SqliteTimelineStore(firstDb);
      await firstStore.putWorkBlock(makeWorkBlock());
      const appended = await firstStore.appendTimelineEvent(makeTimelineEventInput());
      firstStore.close();
      firstDb.close();

      const reopenedDb = initSqliteDb(dbPath);
      const reopenedStore = new SqliteTimelineStore(reopenedDb);
      try {
        const block = await reopenedStore.getWorkBlock("wb-persist-1");
        expect(block).toEqual(makeWorkBlock());
        expect(await reopenedStore.currentTimelineResourceVersion("session-persist")).toBe(
          appended.resourceVersion,
        );
        expect(await reopenedStore.listTimelineEvents({ sessionId: "session-persist" })).toEqual([
          appended,
        ]);
      } finally {
        reopenedStore.close();
        reopenedDb.close();
      }
    } finally {
      await cleanup();
    }
  });
});

function makeWorkBlock(): WorkBlock {
  return {
    workBlockId: "wb-persist-1",
    sessionId: "session-persist",
    goal: "Persist timeline state",
    actor: { agentId: "agent-persist", role: "coder", platform: "codex" },
    origin: WorkBlockOrigin.Agent,
    status: WorkBlockStatus.Running,
    startedAt: "2026-05-13T12:00:00.000Z",
    updatedAt: "2026-05-13T12:01:00.000Z",
    inputRefs: [{ kind: "Issue", id: "375", label: "Task 3" }],
    outputRefs: [],
    evidenceRefs: [],
    approvalRefs: [],
    contributionCids: ["cid-persist"],
    artifactHashes: ["hash-persist"],
    claimIds: ["claim-persist"],
    costSummary: { inputTokens: 10, outputTokens: 20, costUsd: 0.01, model: "gpt-test" },
    links: [{ kind: "URL", id: "plan", href: "https://example.test/plan" }],
    context: { phase: "test" },
    revision: 3,
    createdAt: "2026-05-13T12:00:00.000Z",
  };
}

function makeMinimalWorkBlock(overrides: Partial<WorkBlock> = {}): WorkBlock {
  return {
    workBlockId: "wb-minimal-1",
    sessionId: "session-minimal",
    goal: "Minimal timeline state",
    actor: { agentId: "agent-minimal", role: "coder", platform: "codex" },
    origin: WorkBlockOrigin.Agent,
    status: WorkBlockStatus.Pending,
    updatedAt: "2026-05-13T12:00:00.000Z",
    inputRefs: [],
    outputRefs: [],
    evidenceRefs: [],
    approvalRefs: [],
    contributionCids: [],
    artifactHashes: [],
    claimIds: [],
    revision: 1,
    createdAt: "2026-05-13T12:00:00.000Z",
    ...overrides,
  };
}

function makeTimelineEventInput(): TimelineEventInput {
  return {
    eventId: "te-persist-1",
    sessionId: "session-persist",
    type: TimelineEventType.WorkBlockStatusChanged,
    occurredAt: "2026-05-13T12:01:00.000Z",
    recordedAt: "2026-05-13T12:01:01.000Z",
    actor: { agentId: "agent-persist", role: "coder", platform: "codex" },
    workBlockId: "wb-persist-1",
    targetRefs: [{ kind: "WorkBlock", id: "wb-persist-1" }],
    payload: { status: WorkBlockStatus.Running },
  };
}

function columnNames(db: Database, tableName: string): readonly string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as readonly {
    readonly name: string;
  }[];
  return rows.map((row) => row.name);
}

function indexNames(db: Database, tableName: string): readonly string[] {
  const rows = db.prepare(`PRAGMA index_list(${tableName})`).all() as readonly {
    readonly name: string;
  }[];
  return rows.map((row) => row.name);
}
