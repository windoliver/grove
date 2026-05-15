import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "../../core/timeline.js";
import { FsCas } from "../../local/fs-cas.js";
import { createSqliteStores } from "../../local/sqlite-store.js";
import type { CliDeps } from "../context.js";
import { parseWorkBlocksArgs, runWorkBlocks } from "./work-blocks.js";

let tmpDir: string;
let deps: CliDeps;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-work-blocks-test-"));
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
  await stores.timelineStore.putWorkBlock(makeWorkBlock("wb_other", "session-other"));
  await stores.timelineStore.appendTimelineEvent({
    eventId: "te_cli",
    sessionId: "session-cli",
    type: TimelineEventType.WorkBlockStarted,
    occurredAt: "2026-05-13T10:00:00.000Z",
    targetRefs: [{ kind: "WorkBlock", id: "wb_cli" }],
    payload: {},
  });
});

afterEach(async () => {
  deps.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("parseWorkBlocksArgs", () => {
  test("parses optional session filter", () => {
    expect(parseWorkBlocksArgs([])).toEqual({});
    expect(parseWorkBlocksArgs(["--session", "session-cli"])).toEqual({
      sessionId: "session-cli",
    });
  });
});

describe("runWorkBlocks", () => {
  test("prints WorkBlocks as JSON with session filtering", async () => {
    const output: string[] = [];

    await runWorkBlocks(parseWorkBlocksArgs(["--session", "session-cli"]), deps, (line) =>
      output.push(line),
    );

    const parsed = JSON.parse(output.join("")) as {
      readonly items: readonly { readonly workBlockId: string }[];
    };
    expect(parsed.items.map((block) => block.workBlockId)).toEqual(["wb_cli"]);
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
