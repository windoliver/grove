import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EventBus, GroveEvent, PublishResult } from "../core/event-bus.js";
import { DEFAULT_SESSION_FINALIZERS } from "../core/lifecycle-metadata.js";
import { makeClaim } from "../core/test-helpers.js";
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

  test("legacy sessions without uid or finalizers are normalized and persisted", async () => {
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

    expect(first?.uid).toBeTruthy();
    expect(second?.uid).toBe(first?.uid);
    expect(first?.finalizers).toEqual(DEFAULT_SESSION_FINALIZERS);
    expect(raw.uid).toBe(first?.uid);
    expect(raw.finalizers).toEqual(DEFAULT_SESSION_FINALIZERS);
    expect(raw.deletionAudit).toEqual([]);
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
      await client.read("/zones/test-zone/contributions/blake3:session-link.json"),
    ).toBeDefined();
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
    const store = new NexusSessionStore(client, "test-zone", {
      claimStore,
      closeRuntime: async () => {
        throw new Error("unused in force path");
      },
    });
    const session = await store.createSession({ goal: "force" });
    await client.write(
      `/zones/test-zone/sessions/${session.id}.json`,
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
});
