import { describe, expect, test } from "bun:test";
import type {
  OutcomeInput,
  OutcomeQuery,
  OutcomeRecord,
  OutcomeStats,
  OutcomeStore,
} from "../core/outcome.js";
import { OutcomeStatus } from "../core/outcome.js";
import { makeContribution } from "../core/test-helpers.js";
import { createTestApp, TEST_AUTH_HEADERS } from "./test-helpers.js";

class RecordingOutcomeStore implements OutcomeStore {
  readonly listCalls: OutcomeQuery[] = [];
  private readonly records: readonly OutcomeRecord[];

  constructor(records: readonly OutcomeRecord[]) {
    this.records = records;
  }

  async set(_cid: string, _input: OutcomeInput): Promise<OutcomeRecord> {
    throw new Error("not implemented");
  }

  async get(cid: string): Promise<OutcomeRecord | undefined> {
    return this.records.find((record) => record.cid === cid);
  }

  async getBatch(cids: readonly string[]): Promise<ReadonlyMap<string, OutcomeRecord>> {
    const wanted = new Set(cids);
    const result = new Map<string, OutcomeRecord>();
    for (const record of this.records) {
      if (wanted.has(record.cid)) result.set(record.cid, record);
    }
    return result;
  }

  async list(query?: OutcomeQuery): Promise<readonly OutcomeRecord[]> {
    this.listCalls.push({ ...(query ?? {}) });
    let rows = [...this.records];
    if (query?.status !== undefined) {
      rows = rows.filter((record) => record.status === query.status);
    }
    if (query?.evaluatedBy !== undefined) {
      rows = rows.filter((record) => record.evaluatedBy === query.evaluatedBy);
    }
    const offset = query?.offset ?? 0;
    const limit = query?.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
  }

  async getStats(): Promise<OutcomeStats> {
    const accepted = this.records.filter(
      (record) => record.status === OutcomeStatus.Accepted,
    ).length;
    const rejected = this.records.filter(
      (record) => record.status === OutcomeStatus.Rejected,
    ).length;
    const crashed = this.records.filter((record) => record.status === OutcomeStatus.Crashed).length;
    const invalidated = this.records.filter(
      (record) => record.status === OutcomeStatus.Invalidated,
    ).length;
    const total = this.records.length;
    return {
      total,
      accepted,
      rejected,
      crashed,
      invalidated,
      acceptanceRate: total > 0 ? accepted / total : 0,
    };
  }

  close(): void {
    // no resources
  }
}

function outcome(cid: string, evaluatedAt: string): OutcomeRecord {
  return {
    cid,
    status: OutcomeStatus.Accepted,
    evaluatedAt,
    evaluatedBy: "test",
  };
}

describe("GET /api/contributions outcome filters", () => {
  test("pages outcome reads when contribution filters are also present", async () => {
    const matching = makeContribution({
      summary: "matching",
      tags: ["target"],
      createdAt: "2026-01-01T00:00:03Z",
    });
    const skippedA = makeContribution({
      summary: "skipped-a",
      tags: ["other"],
      createdAt: "2026-01-01T00:00:02Z",
    });
    const skippedB = makeContribution({
      summary: "skipped-b",
      tags: ["other"],
      createdAt: "2026-01-01T00:00:01Z",
    });
    const outcomeStore = new RecordingOutcomeStore([
      outcome(skippedA.cid, "2026-01-01T00:00:03Z"),
      outcome(matching.cid, "2026-01-01T00:00:02Z"),
      outcome(skippedB.cid, "2026-01-01T00:00:01Z"),
    ]);
    const { app, contributionStore } = createTestApp({ outcomeStore });
    await contributionStore.putMany([matching, skippedA, skippedB]);

    const res = await app.request("/api/contributions?outcome=accepted&tags=target&limit=1", {
      headers: TEST_AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ cid: string }>;
    expect(body.map((row) => row.cid)).toEqual([matching.cid]);
    expect(outcomeStore.listCalls.length).toBeGreaterThan(0);
    expect(outcomeStore.listCalls.every((query) => query.limit !== undefined)).toBe(true);
  });
});
