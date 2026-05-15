import { describe, expect, test } from "bun:test";
import { LocalEventBus } from "../core/local-event-bus.js";
import type { WorkBlock } from "../core/timeline.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "../core/timeline.js";
import { runTimelineStoreConformance } from "../core/timeline-store.conformance.js";
import type { WriteBatchEntry, WriteOptions, WriteResult } from "./client.js";
import { MockNexusClient } from "./mock-client.js";
import { NexusTimelineStore } from "./nexus-timeline-store.js";
import {
  ENTITY_CHANGED,
  type EntityChangedEnvelope,
  NexusWatchPublisher,
} from "./nexus-watch-publisher.js";
import { workBlockSessionIndexPath, workBlockStatusIndexPath } from "./vfs-paths.js";

runTimelineStoreConformance({
  name: "NexusTimelineStore",
  async createStore() {
    const client = new MockNexusClient();
    const store = new NexusTimelineStore({ client, zoneId: "zone/test" });
    return {
      store,
      close: () => {
        store.close();
      },
    };
  },
});

describe("NexusTimelineStore cursor idempotency", () => {
  test("duplicate appendTimelineEvent by event id returns the same resource version", async () => {
    const client = new MockNexusClient();
    const store = new NexusTimelineStore({ client, zoneId: "zone/test" });

    const input = {
      eventId: "te-idempotent",
      sessionId: "session/idempotent",
      type: TimelineEventType.WorkBlockCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      recordedAt: "2026-05-13T10:00:01.000Z",
      actor: { agentId: "agent-1", role: "coder", platform: "codex" },
      workBlockId: "wb-idempotent",
      targetRefs: [{ kind: "WorkBlock", id: "wb-idempotent" }],
      payload: {},
    };

    const first = await store.appendTimelineEvent(input);
    const duplicate = await store.appendTimelineEvent(input);

    expect(first.resourceVersion).toBe("1");
    expect(duplicate.resourceVersion).toBe(first.resourceVersion);
    expect(await store.currentTimelineResourceVersion("session/idempotent")).toBe("1");
  });

  test("concurrent duplicate appends store and publish one event", async () => {
    const client = new MockNexusClient();
    const bus = new LocalEventBus();
    const published = captureEntityChanged(bus);
    const publisher = new NexusWatchPublisher(bus, "timeline-test");
    const storeA = new NexusTimelineStore({
      client,
      zoneId: "zone/test",
      watchPublisher: publisher,
    });
    const storeB = new NexusTimelineStore({
      client,
      zoneId: "zone/test",
      watchPublisher: publisher,
    });

    const input = {
      eventId: "te-race",
      sessionId: "session/race",
      type: TimelineEventType.WorkBlockCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      recordedAt: "2026-05-13T10:00:01.000Z",
      actor: { agentId: "agent-1", role: "coder", platform: "codex" },
      workBlockId: "wb-race",
      targetRefs: [{ kind: "WorkBlock", id: "wb-race" }],
      payload: {},
    };

    const [first, second] = await Promise.all([
      storeA.appendTimelineEvent(input),
      storeB.appendTimelineEvent(input),
    ]);

    expect(second).toEqual(first);
    expect(
      (await storeA.listTimelineEvents({ sessionId: "session/race" })).map((e) => e.eventId),
    ).toEqual(["te-race"]);
    const timelinePublishes = published.filter((event) => event.kind === "TimelineEvent");
    expect(timelinePublishes).toHaveLength(1);
    expect(timelinePublishes[0]?.entity?.kind).toBe("TimelineEvent");
  });

  test("retry repairs an event whose by-id row exists without an ordered row", async () => {
    const client = new OrderedWriteFailureClient();
    const bus = new LocalEventBus();
    const published = captureEntityChanged(bus);
    const publisher = new NexusWatchPublisher(bus, "timeline-test");
    const store = new NexusTimelineStore({
      client,
      zoneId: "zone/test",
      watchPublisher: publisher,
    });
    const input = {
      eventId: "te-partial",
      sessionId: "session/partial",
      type: TimelineEventType.WorkBlockCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      recordedAt: "2026-05-13T10:00:01.000Z",
      actor: { agentId: "agent-1", role: "coder", platform: "codex" },
      workBlockId: "wb-partial",
      targetRefs: [{ kind: "WorkBlock", id: "wb-partial" }],
      payload: {},
    };

    client.failOrderedWrites = true;
    await expect(store.appendTimelineEvent(input)).rejects.toThrow();
    expect(await store.currentTimelineResourceVersion("session/partial")).toBe("0");
    client.failOrderedWrites = false;

    const retried = await store.appendTimelineEvent(input);

    expect(retried.eventId).toBe("te-partial");
    expect(
      (await store.listTimelineEvents({ sessionId: "session/partial" })).map((e) => e.eventId),
    ).toEqual(["te-partial"]);
    expect(await store.currentTimelineResourceVersion("session/partial")).toBe("1");
    expect(published.filter((event) => event.kind === "TimelineEvent")).toHaveLength(1);
  });

  test("concurrent repair publishes only from the closed marker winner", async () => {
    const client = new PausedTimelineCloseClient();
    const bus = new LocalEventBus();
    const published = captureEntityChanged(bus);
    const publisher = new NexusWatchPublisher(bus, "timeline-test");
    const input = {
      eventId: "te-repair-race",
      sessionId: "session/repair-race",
      type: TimelineEventType.WorkBlockCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      recordedAt: "2026-05-13T10:00:01.000Z",
      actor: { agentId: "agent-1", role: "coder", platform: "codex" },
      workBlockId: "wb-repair-race",
      targetRefs: [{ kind: "WorkBlock", id: "wb-repair-race" }],
      payload: {},
    };
    const seedStore = new NexusTimelineStore({
      client,
      zoneId: "zone/test",
      watchPublisher: publisher,
    });
    client.failOrderedWrites = true;
    await expect(seedStore.appendTimelineEvent(input)).rejects.toThrow();
    client.failOrderedWrites = false;

    const storeA = new NexusTimelineStore({
      client,
      zoneId: "zone/test",
      watchPublisher: publisher,
    });
    const storeB = new NexusTimelineStore({
      client,
      zoneId: "zone/test",
      watchPublisher: publisher,
    });

    const closeReached = client.pauseNextTimelineCloseWrite();
    const firstRepair = storeA.appendTimelineEvent(input);
    await closeReached;
    const secondRepair = await storeB.appendTimelineEvent(input);
    client.releasePausedCloseWrite();
    const first = await firstRepair;

    expect(first).toEqual(secondRepair);
    expect(
      (await storeA.listTimelineEvents({ sessionId: "session/repair-race" })).map((e) => e.eventId),
    ).toEqual(["te-repair-race"]);
    expect(await storeA.currentTimelineResourceVersion("session/repair-race")).toBe("1");
    expect(published.filter((event) => event.kind === "TimelineEvent")).toHaveLength(1);
  });

  test("duplicate event id across scopes closes the skipped allocation in the losing scope", async () => {
    const client = new MockNexusClient();
    const storeA = new NexusTimelineStore({ client, zoneId: "zone/test" });
    const storeB = new NexusTimelineStore({ client, zoneId: "zone/test" });
    const baseInput = {
      eventId: "te-cross-scope",
      type: TimelineEventType.WorkBlockCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      recordedAt: "2026-05-13T10:00:01.000Z",
      actor: { agentId: "agent-1", role: "coder", platform: "codex" },
      workBlockId: "wb-cross-scope",
      targetRefs: [{ kind: "WorkBlock", id: "wb-cross-scope" }],
      payload: {},
    };

    const [first, second] = await Promise.all([
      storeA.appendTimelineEvent({ ...baseInput, sessionId: "session/a" }),
      storeB.appendTimelineEvent({ ...baseInput, sessionId: "session/b" }),
    ]);

    expect(second).toEqual(first);
    expect(await storeA.currentTimelineResourceVersion("session/a")).toBe("1");
    expect(await storeA.currentTimelineResourceVersion("session/b")).toBe("1");
    const winningSession = first.sessionId;
    if (winningSession === undefined) {
      throw new Error("test fixture must produce a session-scoped winning event");
    }
    const losingSession = winningSession === "session/a" ? "session/b" : "session/a";
    expect(
      (await storeA.listTimelineEvents({ sessionId: winningSession })).map(
        (event) => event.eventId,
      ),
    ).toEqual(["te-cross-scope"]);
    expect(await storeA.listTimelineEvents({ sessionId: losingSession })).toEqual([]);
  });
});

describe("NexusTimelineStore work block indexes", () => {
  test("writes WorkBlock JSON bodies to status and session index files", async () => {
    const client = new MockNexusClient();
    const store = new NexusTimelineStore({ client, zoneId: "zone/test" });
    const block: WorkBlock = {
      workBlockId: "wb-index",
      sessionId: "session/index",
      goal: "Index work block body",
      actor: { agentId: "agent-1", role: "coder", platform: "codex" },
      origin: WorkBlockOrigin.Agent,
      status: WorkBlockStatus.Running,
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

    await store.putWorkBlock(block);

    const statusBody = await client.read(
      workBlockStatusIndexPath("zone/test", block.status, block.updatedAt, block.workBlockId),
    );
    if (block.sessionId === undefined) {
      throw new Error("test fixture must include a sessionId");
    }
    const sessionBody = await client.read(
      workBlockSessionIndexPath("zone/test", block.sessionId, block.updatedAt, block.workBlockId),
    );
    expect(decodeJson(statusBody)).toEqual(block);
    expect(decodeJson(sessionBody)).toEqual(block);
  });

  test("cleans stale WorkBlock indexes after status and timestamp changes", async () => {
    const client = new MockNexusClient();
    const store = new NexusTimelineStore({ client, zoneId: "zone/test" });
    const block = makeWorkBlock("wb-index-cleanup");
    if (block.sessionId === undefined) {
      throw new Error("test fixture must include a sessionId");
    }
    await store.putWorkBlock(block);
    const oldStatusPath = workBlockStatusIndexPath(
      "zone/test",
      block.status,
      block.updatedAt,
      block.workBlockId,
    );
    const oldSessionPath = workBlockSessionIndexPath(
      "zone/test",
      block.sessionId,
      block.updatedAt,
      block.workBlockId,
    );

    const patched = await store.patchWorkBlock(block.workBlockId, {
      status: WorkBlockStatus.Completed,
    });

    expect(await client.exists(oldStatusPath)).toBe(false);
    expect(await client.exists(oldSessionPath)).toBe(false);
    expect(
      await client.exists(
        workBlockStatusIndexPath(
          "zone/test",
          patched.status,
          patched.updatedAt,
          patched.workBlockId,
        ),
      ),
    ).toBe(true);
  });

  test("concurrent patches preserve both changes and increment revisions", async () => {
    const client = new MockNexusClient();
    const bus = new LocalEventBus();
    const published = captureEntityChanged(bus);
    const publisher = new NexusWatchPublisher(bus, "timeline-test");
    const storeA = new NexusTimelineStore({
      client,
      zoneId: "zone/test",
      watchPublisher: publisher,
    });
    const storeB = new NexusTimelineStore({
      client,
      zoneId: "zone/test",
      watchPublisher: publisher,
    });
    const block = makeWorkBlock("wb-patch-race");
    const outputRef = { kind: "Artifact", id: "artifact-1" };
    await storeA.putWorkBlock(block);

    await Promise.all([
      storeA.patchWorkBlock(block.workBlockId, { status: WorkBlockStatus.Running }),
      storeB.patchWorkBlock(block.workBlockId, { outputRefs: [outputRef] }),
    ]);

    const finalBlock = await storeA.getWorkBlock(block.workBlockId);
    expect(finalBlock?.revision).toBe(3);
    expect(finalBlock?.status).toBe(WorkBlockStatus.Running);
    expect(finalBlock?.outputRefs).toEqual([outputRef]);
    const workBlockPublishes = published.filter((event) => event.kind === "WorkBlock");
    expect(workBlockPublishes.every((event) => event.entity?.kind === "WorkBlock")).toBe(true);
  });

  test("stale concurrent patch side effects do not leave superseded indexes or publish stale snapshots", async () => {
    const client = new PausedIndexWriteClient();
    const bus = new LocalEventBus();
    const published = captureEntityChanged(bus);
    const publisher = new NexusWatchPublisher(bus, "timeline-test");
    const storeA = new NexusTimelineStore({
      client,
      zoneId: "zone/test",
      watchPublisher: publisher,
    });
    const storeB = new NexusTimelineStore({
      client,
      zoneId: "zone/test",
      watchPublisher: publisher,
    });
    const block = makeWorkBlock("wb-stale-index-race");
    const outputRef = { kind: "Artifact", id: "artifact-1" };
    await storeA.putWorkBlock(block);

    const { stalePatch, currentPatch } = await withFrozenTime(
      "2026-05-13T10:00:00.000Z",
      async () => {
        const firstIndexWriteReached = client.pauseNextWorkBlockIndexBatch();
        const stalePatchPromise = storeA.patchWorkBlock(block.workBlockId, {
          status: WorkBlockStatus.Running,
        });
        await firstIndexWriteReached;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const currentPatch = await storeB.patchWorkBlock(block.workBlockId, {
          outputRefs: [outputRef],
        });
        client.releasePausedBatch();
        const stalePatch = await stalePatchPromise;
        return { stalePatch, currentPatch };
      },
    );

    const finalBlock = await storeA.getWorkBlock(block.workBlockId);
    expect(finalBlock).toEqual(currentPatch);
    expect(stalePatch.updatedAt).not.toBe(currentPatch.updatedAt);
    if (stalePatch.sessionId === undefined) {
      throw new Error("test fixture must include a sessionId");
    }
    expect(
      await client.exists(
        workBlockStatusIndexPath(
          "zone/test",
          stalePatch.status,
          stalePatch.updatedAt,
          stalePatch.workBlockId,
        ),
      ),
    ).toBe(false);
    expect(
      await client.exists(
        workBlockSessionIndexPath(
          "zone/test",
          stalePatch.sessionId,
          stalePatch.updatedAt,
          stalePatch.workBlockId,
        ),
      ),
    ).toBe(false);
    expect(
      published.filter((event) => event.kind === "WorkBlock").map((event) => event.generation),
    ).toEqual([1, 3]);
  });
});

function decodeJson(data: Uint8Array | undefined): unknown {
  if (data === undefined) return undefined;
  return JSON.parse(new TextDecoder().decode(data)) as unknown;
}

function makeWorkBlock(workBlockId: string): WorkBlock {
  return {
    workBlockId,
    sessionId: "session/index",
    goal: "Index work block body",
    actor: { agentId: "agent-1", role: "coder", platform: "codex" },
    origin: WorkBlockOrigin.Agent,
    status: WorkBlockStatus.Pending,
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

function captureEntityChanged(bus: LocalEventBus): EntityChangedEnvelope[] {
  const published: EntityChangedEnvelope[] = [];
  bus.subscribe("*", (event) => {
    if (event.type === ENTITY_CHANGED) {
      published.push(event.payload as unknown as EntityChangedEnvelope);
    }
  });
  return published;
}

class OrderedWriteFailureClient extends MockNexusClient {
  failOrderedWrites = false;

  override async write(
    path: string,
    content: Uint8Array,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    if (this.failOrderedWrites && path.includes("/timeline/events/")) {
      throw new Error("ordered timeline write blocked");
    }
    return super.write(path, content, opts);
  }
}

class PausedTimelineCloseClient extends OrderedWriteFailureClient {
  private closePause: PauseState | undefined;

  pauseNextTimelineCloseWrite(): Promise<void> {
    if (this.closePause !== undefined) {
      throw new Error("timeline close write pause is already armed");
    }
    const reached = createDeferred();
    const release = createDeferred();
    this.closePause = { reached, release, consumed: false };
    return reached.promise;
  }

  releasePausedCloseWrite(): void {
    const pause = this.closePause;
    if (pause === undefined) {
      throw new Error("no paused timeline close write to release");
    }
    pause.release.resolve();
  }

  override async write(
    path: string,
    content: Uint8Array,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    const pause = this.closePause;
    if (pause !== undefined && !pause.consumed && path.includes("/timeline/closed/")) {
      pause.consumed = true;
      pause.reached.resolve();
      await pause.release.promise;
      this.closePause = undefined;
    }
    return super.write(path, content, opts);
  }
}

class PausedIndexWriteClient extends MockNexusClient {
  private pause: PauseState | undefined;

  pauseNextWorkBlockIndexBatch(): Promise<void> {
    if (this.pause !== undefined) {
      throw new Error("index write pause is already armed");
    }
    const reached = createDeferred();
    const release = createDeferred();
    this.pause = { reached, release, consumed: false };
    return reached.promise;
  }

  releasePausedBatch(): void {
    const pause = this.pause;
    if (pause === undefined) {
      throw new Error("no paused index write to release");
    }
    pause.release.resolve();
  }

  override async writeBatch(files: readonly WriteBatchEntry[]): Promise<readonly WriteResult[]> {
    const pause = this.pause;
    if (pause !== undefined && !pause.consumed && isWorkBlockIndexBatch(files)) {
      pause.consumed = true;
      pause.reached.resolve();
      await pause.release.promise;
      this.pause = undefined;
    }
    return super.writeBatch(files);
  }
}

interface PauseState {
  readonly reached: Deferred;
  readonly release: Deferred;
  consumed: boolean;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferred(): Deferred {
  let resolveFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  if (resolveFn === undefined) {
    throw new Error("deferred resolver was not initialized");
  }
  return { promise, resolve: resolveFn };
}

function isWorkBlockIndexBatch(files: readonly WriteBatchEntry[]): boolean {
  return files.length > 0 && files.every((file) => file.path.includes("/indexes/work-blocks/"));
}

async function withFrozenTime<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const OriginalDate = globalThis.Date;
  const frozenMs = OriginalDate.parse(iso);
  class FrozenDate extends OriginalDate {
    constructor(value?: string | number | Date) {
      if (value === undefined) {
        super(frozenMs);
      } else {
        super(value);
      }
    }

    static override now(): number {
      return frozenMs;
    }
  }
  globalThis.Date = FrozenDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = OriginalDate;
  }
}
