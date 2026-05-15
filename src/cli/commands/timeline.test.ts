import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "../../core/timeline.js";
import { FsCas } from "../../local/fs-cas.js";
import { createSqliteStores } from "../../local/sqlite-store.js";
import type { CliDeps } from "../context.js";
import { parseTimelineArgs, runTimeline } from "./timeline.js";

let tmpDir: string;
let deps: CliDeps;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-timeline-test-"));
  const stores = createSqliteStores(join(tmpDir, "grove.db"));
  const cas = new FsCas(join(tmpDir, "cas"));
  deps = {
    store: stores.contributionStore,
    claimStore: stores.claimStore,
    timelineStore: stores.timelineStore,
    frontier: new DefaultFrontierCalculator(stores.contributionStore),
    workspace: undefined as never,
    cas,
    groveRoot: tmpDir,
    close: () => stores.close(),
  };
  await stores.timelineStore.putWorkBlock(makeWorkBlock("wb_cli", "session-cli"));
  await stores.timelineStore.appendTimelineEvent({
    eventId: "te_cli_1",
    sessionId: "session-cli",
    type: TimelineEventType.WorkBlockStarted,
    occurredAt: "2026-05-13T10:00:00.000Z",
    targetRefs: [{ kind: "WorkBlock", id: "wb_cli" }],
    payload: {},
  });
  await stores.timelineStore.appendTimelineEvent({
    eventId: "te_cli_2",
    sessionId: "session-cli",
    type: TimelineEventType.CostReported,
    occurredAt: "2026-05-13T10:01:00.000Z",
    targetRefs: [{ kind: "WorkBlock", id: "wb_cli" }],
    payload: { costUsd: 0.02 },
  });
});

afterEach(async () => {
  deps.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("parseTimelineArgs", () => {
  test("parses filters and include flag", () => {
    expect(
      parseTimelineArgs([
        "--session",
        "session-cli",
        "--after-rv",
        "1",
        "--limit",
        "5",
        "--include-work-blocks",
      ]),
    ).toEqual({
      sessionId: "session-cli",
      afterRv: "1",
      limit: 5,
      includeWorkBlocks: true,
    });
  });

  test("rejects invalid limit", () => {
    expect(() => parseTimelineArgs(["--limit", "0"])).toThrow("Invalid limit");
  });
});

describe("runTimeline", () => {
  test("prints timeline JSON with after-rv and optional WorkBlocks", async () => {
    const output: string[] = [];

    await runTimeline(
      parseTimelineArgs(["--session", "session-cli", "--after-rv", "1", "--include-work-blocks"]),
      deps,
      (line) => output.push(line),
    );

    const parsed = JSON.parse(output.join("")) as {
      readonly events: readonly { readonly eventId: string }[];
      readonly workBlocks?: readonly { readonly workBlockId: string }[];
      readonly timelineResourceVersion: string;
    };
    expect(parsed.events.map((event) => event.eventId)).toEqual(["te_cli_2"]);
    expect(parsed.workBlocks?.map((block) => block.workBlockId)).toEqual(["wb_cli"]);
    expect(parsed.timelineResourceVersion).toBe("2");
  });
});

function makeWorkBlock(workBlockId: string, sessionId: string) {
  return {
    workBlockId,
    sessionId,
    goal: "Inspect CLI timeline",
    actor: { agentId: "agent-1" },
    origin: WorkBlockOrigin.Agent,
    status: WorkBlockStatus.Running,
    startedAt: "2026-05-13T10:00:00.000Z",
    updatedAt: "2026-05-13T10:00:00.000Z",
    inputRefs: [],
    outputRefs: [],
    evidenceRefs: [],
    approvalRefs: [],
    contributionCids: [],
    artifactHashes: [],
    claimIds: [],
    revision: 1,
    createdAt: "2026-05-13T10:00:00.000Z",
  };
}
