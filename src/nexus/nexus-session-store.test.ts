import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EventBus, GroveEvent, PublishResult } from "../core/event-bus.js";
import { DEFAULT_SESSION_FINALIZERS } from "../core/lifecycle-metadata.js";
import type { Session } from "../core/session.js";
import type { ClaimStore } from "../core/store.js";
import { makeClaim } from "../core/test-helpers.js";
import type { NexusClient } from "./client.js";
import { MockNexusClient } from "./mock-client.js";
import { NexusClaimStore } from "./nexus-claim-store.js";
import { NexusSessionStore } from "./nexus-session-store.js";
import { NexusWatchPublisher } from "./nexus-watch-publisher.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

class RecordingEventBus implements EventBus {
  readonly events: GroveEvent[] = [];

  async publish(event: GroveEvent): Promise<PublishResult> {
    this.events.push(event);
    return { ok: true };
  }

  subscribe(): void {
    return;
  }

  unsubscribe(): void {
    return;
  }

  close(): void {
    return;
  }
}

async function readJson(client: MockNexusClient, path: string): Promise<unknown> {
  const data = await client.read(path);
  return data === undefined ? undefined : JSON.parse(decoder.decode(data));
}

function createSessionWriteRecorder(
  client: MockNexusClient,
  sessionPath: string,
): {
  readonly client: NexusClient;
  readonly writes: Session[];
} {
  const writes: Session[] = [];
  const wrapped: NexusClient = {
    read: (path) => client.read(path),
    readWithMeta: (path) => client.readWithMeta(path),
    write: async (path, content, opts) => {
      if (path === sessionPath) {
        writes.push(JSON.parse(decoder.decode(content)) as Session);
      }
      return client.write(path, content, opts);
    },
    writeBatch: (files) => client.writeBatch(files),
    exists: (path) => client.exists(path),
    stat: (path) => client.stat(path),
    delete: (path) => client.delete(path),
    list: (path, opts) => client.list(path, opts),
    mkdir: (path, opts) => client.mkdir(path, opts),
    search: (query, opts) => client.search(query, opts),
    close: () => client.close(),
  };
  return { client: wrapped, writes };
}

describe("NexusSessionStore", () => {
  let client: MockNexusClient;
  let eventBus: RecordingEventBus;
  let claimStore: NexusClaimStore;

  beforeEach(() => {
    client = new MockNexusClient();
    eventBus = new RecordingEventBus();
    claimStore = new NexusClaimStore({
      client,
      zoneId: "test-zone",
      retryMaxAttempts: 1,
      watchPublisher: new NexusWatchPublisher(eventBus),
    });
  });

  afterEach(async () => {
    claimStore.close();
    await client.close();
  });

  test("createSession/getSession/listSessions persist uid, finalizers, and deletion metadata", async () => {
    const store = new NexusSessionStore(client, "test-zone");

    const created = await store.createSession({ goal: "metadata" });
    const fetched = await store.getSession(created.id);
    const listed = await store.listSessions();

    expect(created.uid).toBeTruthy();
    expect(created.finalizers).toEqual(DEFAULT_SESSION_FINALIZERS);
    expect(created.deletionAudit).toEqual([]);
    expect(fetched).toMatchObject({
      id: created.id,
      uid: created.uid,
      finalizers: DEFAULT_SESSION_FINALIZERS,
      deletionAudit: [],
    });
    expect(listed.find((session) => session.id === created.id)).toMatchObject({
      uid: created.uid,
      finalizers: DEFAULT_SESSION_FINALIZERS,
      deletionAudit: [],
    });
  });

  test("legacy sessions without uid are normalized and persisted without rewriting missing finalizers", async () => {
    await client.write(
      "/zones/test-zone/sessions/legacy.json",
      encoder.encode(
        JSON.stringify({
          id: "legacy",
          goal: "legacy",
          status: "active",
          createdAt: "2026-05-07T00:00:00.000Z",
          contributionCount: 0,
        }),
      ),
    );
    const store = new NexusSessionStore(client, "test-zone");

    const first = await store.getSessionRecord("legacy");
    const second = await store.getSessionRecord("legacy");
    const raw = (await readJson(client, "/zones/test-zone/sessions/legacy.json")) as {
      uid?: string;
      finalizers?: readonly string[];
      deletionAudit?: readonly unknown[];
    };

    expect(first?.uid).toBe("legacy");
    expect(second?.uid).toBe("legacy");
    expect(first?.finalizers).toEqual([]);
    expect(raw.uid).toBe("legacy");
    expect(raw.finalizers).toBeUndefined();
  });

  test("legacy sessions without uid match legacy owner refs during cleanup", async () => {
    await client.write(
      "/zones/test-zone/sessions/legacy.json",
      encoder.encode(
        JSON.stringify({
          id: "legacy",
          goal: "legacy cleanup",
          status: "active",
          createdAt: "2026-05-07T00:00:00.000Z",
          contributionCount: 0,
        }),
      ),
    );
    await claimStore.createClaim(
      makeClaim({
        claimId: "legacy-owned-claim",
        targetRef: "legacy-owned-target",
        ownerRef: { kind: "session", id: "legacy", uid: "legacy" },
      }),
    );
    const store = new NexusSessionStore(client, "test-zone", { claimStore });

    const fetched = await store.getSessionRecord("legacy");
    const rawAfterRead = (await readJson(client, "/zones/test-zone/sessions/legacy.json")) as {
      uid?: string;
      finalizers?: readonly string[];
    };
    const blockers = await store.listSessionDeleteBlockers("legacy");
    const result = await store.deleteSession("legacy");

    expect(fetched?.uid).toBe("legacy");
    expect(rawAfterRead.uid).toBe("legacy");
    expect(rawAfterRead.finalizers).toBeUndefined();
    expect(blockers).toEqual([
      { finalizer: "grove.io/release-slots", message: "1 active owned claim remain" },
    ]);
    expect(result).toEqual({
      sessionId: "legacy",
      deleted: true,
      forced: false,
      blockers: [],
    });
    expect(await claimStore.getClaim("legacy-owned-claim")).toBeUndefined();
  });

  test("getContributions reads legacy arrays and addContribution rewrites them to v2 owner links", async () => {
    const store = new NexusSessionStore(client, "test-zone");
    const session = await store.createSession({ goal: "sidecar migration" });
    await client.write(
      `/zones/test-zone/sessions/${session.id}.contributions.json`,
      encoder.encode(JSON.stringify(["blake3:one", "blake3:two"])),
    );

    expect(await store.getContributions(session.id)).toEqual(["blake3:one", "blake3:two"]);

    await store.addContribution(session.id, "blake3:three");

    const raw = (await readJson(
      client,
      `/zones/test-zone/sessions/${session.id}.contributions.json`,
    )) as {
      version: number;
      items: Array<{
        cid: string;
        ownerRef: { kind: string; id: string; uid: string };
        addedAt: string;
      }>;
    };
    expect(await store.getContributions(session.id)).toEqual([
      "blake3:one",
      "blake3:two",
      "blake3:three",
    ]);
    expect(raw.version).toBe(2);
    expect(raw.items.map((item) => item.cid)).toEqual(["blake3:one", "blake3:two", "blake3:three"]);
    for (const item of raw.items) {
      expect(item.ownerRef).toEqual({ kind: "session", id: session.id, uid: session.uid });
      expect(item.addedAt).toBeTruthy();
    }
    expect(
      await readJson(client, `/zones/test-zone/sessions/${session.id}.contributions/blake3:three`),
    ).toMatchObject({
      cid: "blake3:three",
      ownerRef: { kind: "session", id: session.id, uid: session.uid },
    });
  });

  test("addContribution preserves concurrent session links", async () => {
    const store = new NexusSessionStore(client, "test-zone");
    const session = await store.createSession({ goal: "Concurrent links" });

    await Promise.all([
      store.addContribution(session.id, "blake3:first"),
      store.addContribution(session.id, "blake3:second"),
    ]);

    const cids = await store.getContributions(session.id);
    expect(new Set(cids)).toEqual(new Set(["blake3:first", "blake3:second"]));
    expect(cids.length).toBe(2);
  });

  test("addContribution preserves bursty concurrent session links", async () => {
    const store = new NexusSessionStore(client, "test-zone");
    const session = await store.createSession({ goal: "Bursty links" });
    const cids = Array.from({ length: 30 }, (_, i) => `blake3:${String(i).padStart(2, "0")}`);

    await Promise.all(cids.map((cid) => store.addContribution(session.id, cid)));

    expect(new Set(await store.getContributions(session.id))).toEqual(new Set(cids));
    expect((await store.getSession(session.id))?.contributionCount).toBe(30);
  });

  test("deleteSession removes an unblocked session record and sidecar but leaves immutable contribution files", async () => {
    const store = new NexusSessionStore(client, "test-zone", { claimStore });
    const session = await store.createSession({ goal: "delete me" });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    await claimStore.createClaim(
      makeClaim({ claimId: "owned-claim", targetRef: "owned-target", ownerRef }),
    );
    await store.addContribution(session.id, "blake3:session-link");
    await client.write(
      "/zones/test-zone/contributions/blake3:session-link.json",
      encoder.encode(JSON.stringify({ cid: "blake3:session-link" })),
    );

    const result = await store.deleteSession(session.id);

    expect(result).toEqual({
      sessionId: session.id,
      deleted: true,
      forced: false,
      blockers: [],
    });
    expect(await store.getSession(session.id)).toBeUndefined();
    expect(await claimStore.getClaim("owned-claim")).toBeUndefined();
    expect(
      await client.read(`/zones/test-zone/sessions/${session.id}.contributions.json`),
    ).toBeUndefined();
    expect(
      await client.read(
        `/zones/test-zone/sessions/${session.id}.contributions/blake3:session-link`,
      ),
    ).toBeUndefined();
    expect(
      await client.read("/zones/test-zone/contributions/blake3:session-link.json"),
    ).toBeDefined();
  });

  test("deleteSession treats a stale finalizer write after concurrent delete as idempotent", async () => {
    const setupStore = new NexusSessionStore(client, "test-zone");
    const session = await setupStore.createSession({ goal: "concurrent delete" });
    const sessionPath = `/zones/test-zone/sessions/${session.id}.json`;
    let deleteBeforeFirstFinalizerWrite = false;
    let successfulSessionWrites = 0;
    const wrappedClient: NexusClient = {
      read: (path) => client.read(path),
      readWithMeta: async (path) => {
        const result = await client.readWithMeta(path);
        if (path === sessionPath && result !== undefined) {
          deleteBeforeFirstFinalizerWrite = true;
        }
        return result;
      },
      write: async (path, content, opts) => {
        if (path === sessionPath && deleteBeforeFirstFinalizerWrite) {
          deleteBeforeFirstFinalizerWrite = false;
          await client.delete(path);
        }
        const result = await client.write(path, content, opts);
        if (path === sessionPath) {
          successfulSessionWrites++;
        }
        return result;
      },
      writeBatch: (files) => client.writeBatch(files),
      exists: (path) => client.exists(path),
      stat: (path) => client.stat(path),
      delete: (path) => client.delete(path),
      list: (path, opts) => client.list(path, opts),
      mkdir: (path, opts) => client.mkdir(path, opts),
      search: (query, opts) => client.search(query, opts),
      close: () => client.close(),
    };
    const store = new NexusSessionStore(wrappedClient, "test-zone", { claimStore });

    const result = await store.deleteSession(session.id);

    expect(result).toEqual({
      sessionId: session.id,
      deleted: true,
      forced: false,
      blockers: [],
    });
    expect(successfulSessionWrites).toBe(0);
    expect(await client.read(sessionPath)).toBeUndefined();
  });

  test("deleteSession retries initial delete-state write after benign CAS conflict", async () => {
    const setupStore = new NexusSessionStore(client, "test-zone");
    const session = await setupStore.createSession({ goal: "initial CAS retry" });
    const sessionPath = `/zones/test-zone/sessions/${session.id}.json`;
    let conflicted = false;
    const wrappedClient: NexusClient = {
      read: (path) => client.read(path),
      readWithMeta: (path) => client.readWithMeta(path),
      write: async (path, content, opts) => {
        if (path === sessionPath && opts?.ifMatch !== undefined && !conflicted) {
          conflicted = true;
          const current = await client.read(path);
          if (current !== undefined) {
            await client.write(path, current);
          }
        }
        return client.write(path, content, opts);
      },
      writeBatch: (files) => client.writeBatch(files),
      exists: (path) => client.exists(path),
      stat: (path) => client.stat(path),
      delete: (path) => client.delete(path),
      list: (path, opts) => client.list(path, opts),
      mkdir: (path, opts) => client.mkdir(path, opts),
      search: (query, opts) => client.search(query, opts),
      close: () => client.close(),
    };
    const store = new NexusSessionStore(wrappedClient, "test-zone", { claimStore });

    const result = await store.deleteSession(session.id);

    expect(conflicted).toBe(true);
    expect(result).toEqual({
      sessionId: session.id,
      deleted: true,
      forced: false,
      blockers: [],
    });
    expect(await client.read(sessionPath)).toBeUndefined();
  });

  test("deleteSession applies default finalizers for legacy sessions after initial CAS conflict", async () => {
    const sessionPath = "/zones/test-zone/sessions/legacy-cas.json";
    await client.write(
      sessionPath,
      encoder.encode(
        JSON.stringify({
          id: "legacy-cas",
          goal: "legacy CAS",
          status: "active",
          createdAt: "2026-05-07T00:00:00.000Z",
          contributionCount: 0,
        }),
      ),
    );
    await claimStore.createClaim(
      makeClaim({
        claimId: "legacy-cas-owned-claim",
        targetRef: "legacy-cas-owned-target",
        ownerRef: { kind: "session", id: "legacy-cas", uid: "legacy-cas" },
      }),
    );
    let conflicted = false;
    const wrappedClient: NexusClient = {
      read: (path) => client.read(path),
      readWithMeta: (path) => client.readWithMeta(path),
      write: async (path, content, opts) => {
        if (path === sessionPath && opts?.ifMatch !== undefined && !conflicted) {
          conflicted = true;
          const current = await client.read(path);
          if (current !== undefined) {
            await client.write(path, current);
          }
        }
        return client.write(path, content, opts);
      },
      writeBatch: (files) => client.writeBatch(files),
      exists: (path) => client.exists(path),
      stat: (path) => client.stat(path),
      delete: (path) => client.delete(path),
      list: (path, opts) => client.list(path, opts),
      mkdir: (path, opts) => client.mkdir(path, opts),
      search: (query, opts) => client.search(query, opts),
      close: () => client.close(),
    };
    const store = new NexusSessionStore(wrappedClient, "test-zone", { claimStore });

    const result = await store.deleteSession("legacy-cas");

    expect(conflicted).toBe(true);
    expect(result).toEqual({
      sessionId: "legacy-cas",
      deleted: true,
      forced: false,
      blockers: [],
    });
    expect(await claimStore.getClaim("legacy-cas-owned-claim")).toBeUndefined();
    expect(await client.read(sessionPath)).toBeUndefined();
  });

  test("deleteSession preserves concurrently added unknown finalizers after CAS conflict", async () => {
    const setupStore = new NexusSessionStore(client, "test-zone");
    const session = await setupStore.createSession({ goal: "concurrent finalizer" });
    const sessionPath = `/zones/test-zone/sessions/${session.id}.json`;
    let conflicted = false;
    const wrappedClient: NexusClient = {
      read: (path) => client.read(path),
      readWithMeta: (path) => client.readWithMeta(path),
      write: async (path, content, opts) => {
        if (path === sessionPath && opts?.ifMatch !== undefined && !conflicted) {
          conflicted = true;
          const current = await client.read(path);
          if (current !== undefined) {
            const currentSession = JSON.parse(decoder.decode(current)) as Session;
            await client.write(
              path,
              encoder.encode(
                JSON.stringify({
                  ...currentSession,
                  finalizers: [...currentSession.finalizers, "grove.io/future-cleanup"],
                }),
              ),
            );
          }
        }
        return client.write(path, content, opts);
      },
      writeBatch: (files) => client.writeBatch(files),
      exists: (path) => client.exists(path),
      stat: (path) => client.stat(path),
      delete: (path) => client.delete(path),
      list: (path, opts) => client.list(path, opts),
      mkdir: (path, opts) => client.mkdir(path, opts),
      search: (query, opts) => client.search(query, opts),
      close: () => client.close(),
    };
    const store = new NexusSessionStore(wrappedClient, "test-zone", { claimStore });

    const result = await store.deleteSession(session.id);
    const fetched = await store.getSession(session.id);

    expect(conflicted).toBe(true);
    expect(result).toEqual({
      sessionId: session.id,
      deleted: false,
      forced: false,
      blockers: [{ finalizer: "grove.io/future-cleanup", message: "unknown finalizer pending" }],
    });
    expect(fetched?.finalizers).toEqual(["grove.io/future-cleanup"]);
  });

  test("deleteSession retries finalizer removal write after benign CAS conflict", async () => {
    const setupStore = new NexusSessionStore(client, "test-zone");
    const session = await setupStore.createSession({ goal: "finalizer CAS retry" });
    const sessionPath = `/zones/test-zone/sessions/${session.id}.json`;
    let sessionWrites = 0;
    let conflicted = false;
    const wrappedClient: NexusClient = {
      read: (path) => client.read(path),
      readWithMeta: (path) => client.readWithMeta(path),
      write: async (path, content, opts) => {
        if (path === sessionPath && opts?.ifMatch !== undefined) {
          sessionWrites += 1;
          if (sessionWrites === 2 && !conflicted) {
            conflicted = true;
            const current = await client.read(path);
            if (current !== undefined) {
              await client.write(path, current);
            }
          }
        }
        return client.write(path, content, opts);
      },
      writeBatch: (files) => client.writeBatch(files),
      exists: (path) => client.exists(path),
      stat: (path) => client.stat(path),
      delete: (path) => client.delete(path),
      list: (path, opts) => client.list(path, opts),
      mkdir: (path, opts) => client.mkdir(path, opts),
      search: (query, opts) => client.search(query, opts),
      close: () => client.close(),
    };
    const store = new NexusSessionStore(wrappedClient, "test-zone", { claimStore });

    const result = await store.deleteSession(session.id);

    expect(conflicted).toBe(true);
    expect(result).toEqual({
      sessionId: session.id,
      deleted: true,
      forced: false,
      blockers: [],
    });
    expect(await client.read(sessionPath)).toBeUndefined();
  });

  test("deleteSession keeps deletionTimestamp and failed/later finalizers when closeRuntime blocks", async () => {
    const store = new NexusSessionStore(client, "test-zone", {
      claimStore,
      closeRuntime: async () => {
        throw new Error("runtime still flushing");
      },
    });
    const session = await store.createSession({ goal: "blocked" });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    await claimStore.createClaim(
      makeClaim({ claimId: "blocking-claim", targetRef: "blocking-target", ownerRef }),
    );
    await store.addContribution(session.id, "blake3:blocking");

    const result = await store.deleteSession(session.id);
    const fetched = await store.getSession(session.id);

    expect(result).toEqual({
      sessionId: session.id,
      deleted: false,
      forced: false,
      blockers: [{ finalizer: "grove.io/close-runtime", message: "runtime still flushing" }],
    });
    expect(fetched?.deletionTimestamp).toBeTruthy();
    expect(fetched?.finalizers).toEqual(["grove.io/close-runtime"]);
    expect(await claimStore.getClaim("blocking-claim")).toBeUndefined();
    expect(await store.getContributions(session.id)).toEqual([]);
  });

  test("deleteSession force returns a warning and deletes unknown-finalizer sessions", async () => {
    const session = await new NexusSessionStore(client, "test-zone").createSession({
      goal: "force",
    });
    const sessionPath = `/zones/test-zone/sessions/${session.id}.json`;
    const { client: recordingClient, writes } = createSessionWriteRecorder(client, sessionPath);
    const failingClaimStore = Object.create(claimStore) as ClaimStore;
    failingClaimStore.releaseOwnedBy = async () => {
      throw new Error("release cleanup failed");
    };
    failingClaimStore.deleteTerminalOwnedBy = async () => 0;
    const store = new NexusSessionStore(recordingClient, "test-zone", {
      claimStore: failingClaimStore,
      closeRuntime: async () => {
        throw new Error("unused in force path");
      },
    });
    await client.write(
      sessionPath,
      encoder.encode(
        JSON.stringify({
          ...(await store.getSessionRecord(session.id)),
          finalizers: ["grove.io/future-cleanup"],
        }),
      ),
    );

    const result = await store.deleteSession(session.id, { force: true, actor: "test" });

    expect(result).toEqual({
      sessionId: session.id,
      deleted: true,
      forced: true,
      blockers: [],
      warning: `force delete skipped finalizer waits for session ${session.id}`,
      cleanupErrors: ["release cleanup failed"],
    });
    expect(writes.at(-1)?.deletionAudit?.at(-1)).toMatchObject({
      actor: "test",
      force: true,
      warning: `force delete skipped finalizer waits for session ${session.id}`,
    });
    expect(await store.getSession(session.id)).toBeUndefined();
  });

  test("listSessionDeleteBlockers reports active owned claims and contribution links", async () => {
    const store = new NexusSessionStore(client, "test-zone", { claimStore });
    const session = await store.createSession({ goal: "blockers" });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    await claimStore.createClaim(
      makeClaim({ claimId: "blocker-claim", targetRef: "blocker-target", ownerRef }),
    );
    await store.addContribution(session.id, "blake3:blocker");

    const blockers = await store.listSessionDeleteBlockers(session.id);

    expect(blockers).toEqual([
      { finalizer: "grove.io/release-slots", message: "1 active owned claim remain" },
      { finalizer: "grove.io/drain-contribs", message: "1 session contribution link remain" },
    ]);
  });

  test("listSessionDeleteBlockers still reports owned resources when only future finalizers remain", async () => {
    const store = new NexusSessionStore(client, "test-zone", { claimStore });
    const session = await store.createSession({ goal: "future blockers" });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    await claimStore.createClaim(
      makeClaim({ claimId: "future-blocker-claim", targetRef: "future-blocker-target", ownerRef }),
    );
    await store.addContribution(session.id, "blake3:future-blocker");
    await client.write(
      `/zones/test-zone/sessions/${session.id}.json`,
      encoder.encode(
        JSON.stringify({
          ...(await store.getSessionRecord(session.id)),
          finalizers: ["grove.io/future-cleanup"],
        }),
      ),
    );

    const blockers = await store.listSessionDeleteBlockers(session.id);

    expect(blockers).toEqual([
      { finalizer: "grove.io/release-slots", message: "1 active owned claim remain" },
      { finalizer: "grove.io/drain-contribs", message: "1 session contribution link remain" },
      { finalizer: "grove.io/future-cleanup", message: "unknown finalizer pending" },
    ]);
  });

  test("unknown finalizers remain pending for normal delete and force delete removes them", async () => {
    const store = new NexusSessionStore(client, "test-zone", { claimStore });
    const session = await store.createSession({ goal: "unknown" });
    await client.write(
      `/zones/test-zone/sessions/${session.id}.json`,
      encoder.encode(
        JSON.stringify({
          ...(await store.getSessionRecord(session.id)),
          finalizers: ["grove.io/future-cleanup"],
        }),
      ),
    );

    const normal = await store.deleteSession(session.id);
    const fetched = await store.getSession(session.id);
    const forced = await store.deleteSession(session.id, { force: true, actor: "test" });

    expect(normal).toEqual({
      sessionId: session.id,
      deleted: false,
      forced: false,
      blockers: [{ finalizer: "grove.io/future-cleanup", message: "unknown finalizer pending" }],
    });
    expect(fetched?.finalizers).toEqual(["grove.io/future-cleanup"]);
    expect(forced.deleted).toBe(true);
    expect(await store.getSession(session.id)).toBeUndefined();
  });

  test("explicit empty finalizers stay drained on read and delete does not resurrect defaults", async () => {
    const store = new NexusSessionStore(client, "test-zone", { claimStore });
    const session = await store.createSession({ goal: "drained" });
    await client.write(
      `/zones/test-zone/sessions/${session.id}.json`,
      encoder.encode(
        JSON.stringify({
          ...(await store.getSessionRecord(session.id)),
          finalizers: [],
        }),
      ),
    );

    const fetched = await store.getSession(session.id);
    const listed = await store.listSessions();
    const rawAfterRead = (await readJson(
      client,
      `/zones/test-zone/sessions/${session.id}.json`,
    )) as {
      finalizers?: readonly string[];
    };
    const deleted = await store.deleteSession(session.id);

    expect(fetched?.finalizers).toEqual([]);
    expect(listed.find((item) => item.id === session.id)?.finalizers).toEqual([]);
    expect(rawAfterRead.finalizers).toEqual([]);
    expect(deleted).toEqual({
      sessionId: session.id,
      deleted: true,
      forced: false,
      blockers: [],
    });
  });

  test("legacy missing finalizers are not rewritten on read but delete still applies default cleanup", async () => {
    const session = await new NexusSessionStore(client, "test-zone").createSession({
      goal: "legacy delete",
    });
    const ownerRef = { kind: "session" as const, id: session.id, uid: session.uid };
    await claimStore.createClaim(
      makeClaim({ claimId: "legacy-delete-claim", targetRef: "legacy-delete-target", ownerRef }),
    );
    await client.write(
      `/zones/test-zone/sessions/${session.id}.json`,
      encoder.encode(
        JSON.stringify({
          id: session.id,
          uid: session.uid,
          goal: session.goal,
          status: session.status,
          createdAt: session.createdAt,
          deletionAudit: [],
          contributionCount: 0,
        }),
      ),
    );

    const store = new NexusSessionStore(client, "test-zone", { claimStore });
    const fetched = await store.getSession(session.id);
    const rawAfterRead = (await readJson(
      client,
      `/zones/test-zone/sessions/${session.id}.json`,
    )) as {
      finalizers?: readonly string[];
    };
    const deleted = await store.deleteSession(session.id);

    expect(fetched?.finalizers).toEqual([]);
    expect(rawAfterRead.finalizers).toBeUndefined();
    expect(deleted).toEqual({
      sessionId: session.id,
      deleted: true,
      forced: false,
      blockers: [],
    });
    expect(await claimStore.getClaim("legacy-delete-claim")).toBeUndefined();
  });

  test("appendSessionRoleSkill updates persisted topology and dedupes", async () => {
    const store = new NexusSessionStore(client, "test-zone");
    const session = await store.createSession({
      goal: "runtime skill",
      topology: {
        structure: "flat",
        roles: [{ name: "coder", skills: ["grove"] }],
      },
    });

    await expect(store.appendSessionRoleSkill(session.id, "coder", "review")).resolves.toBe(
      "appended",
    );
    await expect(store.appendSessionRoleSkill(session.id, "coder", "review")).resolves.toBe(
      "already_present",
    );

    const fetched = await store.getSession(session.id);
    expect(fetched?.topology?.roles[0]?.skills).toEqual(["grove", "review"]);
  });

  test("appendSessionRoleSkill reports missing session and role", async () => {
    const store = new NexusSessionStore(client, "test-zone");
    await expect(store.appendSessionRoleSkill("missing", "coder", "review")).resolves.toBe(
      "session_missing",
    );

    const session = await store.createSession({
      goal: "runtime skill",
      topology: { structure: "flat", roles: [{ name: "coder" }] },
    });
    await expect(store.appendSessionRoleSkill(session.id, "reviewer", "review")).resolves.toBe(
      "role_missing",
    );
  });

  test("appendSessionRoleSkill preserves missing legacy finalizers and delete cleanup", async () => {
    const sessionId = "legacy-append";
    await client.write(
      `/zones/test-zone/sessions/${sessionId}.json`,
      encoder.encode(
        JSON.stringify({
          id: sessionId,
          goal: "legacy append",
          status: "active",
          createdAt: "2026-05-07T00:00:00.000Z",
          contributionCount: 0,
          topology: {
            structure: "flat",
            roles: [{ name: "coder", skills: ["grove"] }],
          },
        }),
      ),
    );
    await claimStore.createClaim(
      makeClaim({
        claimId: "legacy-append-claim",
        targetRef: "legacy-append-target",
        ownerRef: { kind: "session", id: sessionId, uid: sessionId },
      }),
    );
    const store = new NexusSessionStore(client, "test-zone", { claimStore });

    await expect(store.appendSessionRoleSkill(sessionId, "coder", "review")).resolves.toBe(
      "appended",
    );
    const rawAfterAppend = (await readJson(
      client,
      `/zones/test-zone/sessions/${sessionId}.json`,
    )) as {
      finalizers?: readonly string[];
      topology?: { roles?: Array<{ skills?: readonly string[] }> };
      uid?: string;
    };
    const deleted = await store.deleteSession(sessionId);

    expect(rawAfterAppend.uid).toBe(sessionId);
    expect(rawAfterAppend.finalizers).toBeUndefined();
    expect(rawAfterAppend.topology?.roles?.[0]?.skills).toEqual(["grove", "review"]);
    expect(deleted).toEqual({
      sessionId,
      deleted: true,
      forced: false,
      blockers: [],
    });
    expect(await claimStore.getClaim("legacy-append-claim")).toBeUndefined();
  });

  test("appendSessionRoleSkill retries ETag conflict from latest topology", async () => {
    const setupStore = new NexusSessionStore(client, "test-zone");
    const session = await setupStore.createSession({
      goal: "runtime skill conflict",
      topology: {
        structure: "flat",
        roles: [{ name: "coder", skills: ["grove"] }],
      },
    });
    const sessionPath = `/zones/test-zone/sessions/${session.id}.json`;
    let conflicted = false;
    const wrappedClient: NexusClient = {
      read: (path) => client.read(path),
      readWithMeta: (path) => client.readWithMeta(path),
      write: async (path, content, opts) => {
        if (path === sessionPath && opts?.ifMatch !== undefined && !conflicted) {
          conflicted = true;
          const current = await client.read(path);
          if (current !== undefined) {
            const currentSession = JSON.parse(decoder.decode(current)) as Session;
            await client.write(
              path,
              encoder.encode(
                JSON.stringify({
                  ...currentSession,
                  topology: {
                    ...currentSession.topology,
                    roles:
                      currentSession.topology?.roles.map((role) =>
                        role.name === "coder"
                          ? { ...role, skills: [...(role.skills ?? []), "audit"] }
                          : role,
                      ) ?? [],
                  },
                }),
              ),
            );
          }
        }
        return client.write(path, content, opts);
      },
      writeBatch: (files) => client.writeBatch(files),
      exists: (path) => client.exists(path),
      stat: (path) => client.stat(path),
      delete: (path) => client.delete(path),
      list: (path, opts) => client.list(path, opts),
      mkdir: (path, opts) => client.mkdir(path, opts),
      search: (query, opts) => client.search(query, opts),
      close: () => client.close(),
    };
    const store = new NexusSessionStore(wrappedClient, "test-zone");

    await expect(store.appendSessionRoleSkill(session.id, "coder", "review")).resolves.toBe(
      "appended",
    );
    const fetched = await setupStore.getSession(session.id);

    expect(conflicted).toBe(true);
    expect(fetched?.topology?.roles[0]?.skills).toEqual(["grove", "audit", "review"]);
  });

  test("appendSessionRoleSkill reports retry exhaustion after repeated ETag conflicts", async () => {
    const setupStore = new NexusSessionStore(client, "test-zone");
    const session = await setupStore.createSession({
      goal: "runtime skill conflict exhaustion",
      topology: {
        structure: "flat",
        roles: [{ name: "coder", skills: ["grove"] }],
      },
    });
    const sessionPath = `/zones/test-zone/sessions/${session.id}.json`;
    let conflicts = 0;
    const wrappedClient: NexusClient = {
      read: (path) => client.read(path),
      readWithMeta: (path) => client.readWithMeta(path),
      write: async (path, content, opts) => {
        if (path === sessionPath && opts?.ifMatch !== undefined) {
          conflicts++;
          const current = await client.read(path);
          if (current !== undefined) {
            await client.write(path, current);
          }
        }
        return client.write(path, content, opts);
      },
      writeBatch: (files) => client.writeBatch(files),
      exists: (path) => client.exists(path),
      stat: (path) => client.stat(path),
      delete: (path) => client.delete(path),
      list: (path, opts) => client.list(path, opts),
      mkdir: (path, opts) => client.mkdir(path, opts),
      search: (query, opts) => client.search(query, opts),
      close: () => client.close(),
    };
    const store = new NexusSessionStore(wrappedClient, "test-zone");

    await expect(store.appendSessionRoleSkill(session.id, "coder", "review")).rejects.toThrow(
      "appendSessionRoleSkill retry loop exhausted",
    );
    expect(conflicts).toBe(3);
  });
});
