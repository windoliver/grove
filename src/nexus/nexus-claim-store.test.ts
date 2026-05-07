import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EventBus, GroveEvent, PublishResult } from "../core/event-bus.js";
import type { OwnerRef } from "../core/lifecycle-metadata.js";
import { ClaimStatus } from "../core/models.js";
import { makeClaim } from "../core/test-helpers.js";
import { MockNexusClient } from "./mock-client.js";
import { NexusClaimStore } from "./nexus-claim-store.js";
import { NexusWatchPublisher } from "./nexus-watch-publisher.js";
import { activeClaimIndexPath, claimPath, targetLockPath } from "./vfs-paths.js";

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

describe("NexusClaimStore ownerRef lifecycle", () => {
  let client: MockNexusClient;
  let eventBus: RecordingEventBus;
  let store: NexusClaimStore;

  beforeEach(() => {
    client = new MockNexusClient();
    eventBus = new RecordingEventBus();
    store = new NexusClaimStore({
      client,
      zoneId: "test-zone",
      retryMaxAttempts: 1,
      watchPublisher: new NexusWatchPublisher(eventBus),
    });
  });

  afterEach(async () => {
    store.close();
    await client.close();
  });

  test("createClaim and claimOrRenew preserve ownerRef filtering by field equality", async () => {
    const ownerRef = { kind: "session", uid: "uid-1", id: "session-1" } as OwnerRef;
    const canonicalOwnerRef: OwnerRef = { kind: "session", id: "session-1", uid: "uid-1" };

    await store.createClaim(
      makeClaim({
        claimId: "owner-create",
        targetRef: "owner-target-create",
        ownerRef,
      }),
    );
    await store.claimOrRenew(
      makeClaim({
        claimId: "owner-renew-origin",
        targetRef: "owner-target-renew",
        agent: { agentId: "agent-renew" },
        ownerRef,
      }),
    );
    await store.claimOrRenew(
      makeClaim({
        claimId: "owner-renew-attempt",
        targetRef: "owner-target-renew",
        agent: { agentId: "agent-renew" },
        ownerRef: canonicalOwnerRef,
        intentSummary: "renewed",
      }),
    );
    await store.createClaim(
      makeClaim({
        claimId: "owner-other",
        targetRef: "owner-target-other",
        ownerRef: { kind: "session", id: "session-1", uid: "uid-2" },
      }),
    );

    const filtered = await store.listClaims({ ownerRef: canonicalOwnerRef });

    expect(filtered.map((claim) => claim.claimId).sort()).toEqual([
      "owner-create",
      "owner-renew-origin",
    ]);
    expect(filtered.every((claim) => claim.ownerRef?.uid === canonicalOwnerRef.uid)).toBe(true);
  });

  test("claimOrRenew same-agent renewal updates stored ownerRef", async () => {
    const initialOwner: OwnerRef = { kind: "session", id: "session-old", uid: "uid-old" };
    const renewedOwner: OwnerRef = { kind: "session", id: "session-new", uid: "uid-new" };
    await store.createClaim(
      makeClaim({
        claimId: "renew-owner-existing",
        targetRef: "renew-owner-target",
        agent: { agentId: "agent-renew-owner" },
        ownerRef: initialOwner,
      }),
    );

    const renewed = await store.claimOrRenew(
      makeClaim({
        claimId: "renew-owner-attempt",
        targetRef: "renew-owner-target",
        agent: { agentId: "agent-renew-owner" },
        ownerRef: renewedOwner,
      }),
    );
    const fetched = await store.getClaim("renew-owner-existing");

    expect(renewed.claimId).toBe("renew-owner-existing");
    expect(renewed.ownerRef).toEqual(renewedOwner);
    expect(fetched?.ownerRef).toEqual(renewedOwner);
    expect(await store.listClaims({ ownerRef: initialOwner })).toEqual([]);
    expect(
      (await store.listClaims({ ownerRef: renewedOwner })).map((claim) => claim.claimId),
    ).toEqual(["renew-owner-existing"]);
  });

  test("releaseOwnedBy releases matching active claims, invalidates active cache, and publishes watch events", async () => {
    const ownerRef: OwnerRef = { kind: "session", id: "release-session", uid: "uid-1" };
    const otherOwner: OwnerRef = { kind: "session", id: "release-session", uid: "uid-2" };
    await store.createClaim(
      makeClaim({
        claimId: "release-owned-active",
        targetRef: "release-target-1",
        ownerRef,
      }),
    );
    await store.createClaim(
      makeClaim({
        claimId: "release-owned-terminal",
        targetRef: "release-target-2",
        ownerRef,
      }),
    );
    await store.release("release-owned-terminal");
    await store.createClaim(
      makeClaim({
        claimId: "release-other-active",
        targetRef: "release-target-3",
        ownerRef: otherOwner,
      }),
    );

    expect((await store.activeClaims()).map((claim) => claim.claimId).sort()).toEqual([
      "release-other-active",
      "release-owned-active",
    ]);
    expect((await store.getClaim("release-owned-active"))?.status).toBe(ClaimStatus.Active);

    const count = await store.releaseOwnedBy(ownerRef);

    expect(count).toBe(1);
    expect((await store.getClaim("release-owned-active"))?.status).toBe(ClaimStatus.Released);
    expect((await store.activeClaims()).map((claim) => claim.claimId)).toEqual([
      "release-other-active",
    ]);
    expect(
      eventBus.events.filter((event) => {
        const payload = event.payload as { entityId?: string; op?: string };
        return payload.entityId === "release-owned-active" && payload.op === "MODIFIED";
      }),
    ).toHaveLength(1);
  });

  test("deleteTerminalOwnedBy deletes matching terminal claims, clears cache, and publishes deletes", async () => {
    const ownerRef: OwnerRef = { kind: "session", id: "delete-session", uid: "uid-1" };
    const otherOwner: OwnerRef = { kind: "session", id: "delete-session", uid: "uid-2" };
    await store.createClaim(
      makeClaim({
        claimId: "delete-owned-active",
        targetRef: "delete-target-1",
        ownerRef,
      }),
    );
    await store.createClaim(
      makeClaim({
        claimId: "delete-owned-terminal",
        targetRef: "delete-target-2",
        ownerRef,
      }),
    );
    await store.release("delete-owned-terminal");
    await store.createClaim(
      makeClaim({
        claimId: "delete-other-terminal",
        targetRef: "delete-target-3",
        ownerRef: otherOwner,
      }),
    );
    await store.release("delete-other-terminal");
    expect((await store.getClaim("delete-owned-terminal"))?.status).toBe(ClaimStatus.Released);

    const count = await store.deleteTerminalOwnedBy(ownerRef);

    expect(count).toBe(1);
    expect(await store.getClaim("delete-owned-terminal")).toBeUndefined();
    expect((await store.getClaim("delete-owned-active"))?.status).toBe(ClaimStatus.Active);
    expect((await store.getClaim("delete-other-terminal"))?.status).toBe(ClaimStatus.Released);
    expect(
      eventBus.events.filter((event) => {
        const payload = event.payload as { entityId?: string; op?: string };
        return payload.entityId === "delete-owned-terminal" && payload.op === "DELETED";
      }),
    ).toHaveLength(1);
  });

  test("deleteTerminalOwnedBy also clears stale active indexes and target locks for terminal claims", async () => {
    const ownerRef: OwnerRef = { kind: "session", id: "stale-session", uid: "uid-1" };
    const otherOwner: OwnerRef = { kind: "session", id: "stale-session", uid: "uid-2" };
    const targetRef = "stale-target";
    await store.createClaim(
      makeClaim({
        claimId: "stale-owned-terminal",
        targetRef,
        ownerRef,
      }),
    );
    await store.release("stale-owned-terminal");
    await client.write(
      activeClaimIndexPath("test-zone", targetRef, "stale-owned-terminal"),
      new Uint8Array(0),
    );
    await client.write(
      targetLockPath("test-zone", targetRef),
      new TextEncoder().encode("stale-owned-terminal"),
    );
    await store.createClaim(
      makeClaim({
        claimId: "stale-other-terminal",
        targetRef: "stale-target-other",
        ownerRef: otherOwner,
      }),
    );
    await store.release("stale-other-terminal");

    const count = await store.deleteTerminalOwnedBy(ownerRef);
    const lockData = await client.read(targetLockPath("test-zone", targetRef));

    expect(count).toBe(1);
    expect(await client.read(claimPath("test-zone", "stale-owned-terminal"))).toBeUndefined();
    expect(
      await client.read(activeClaimIndexPath("test-zone", targetRef, "stale-owned-terminal")),
    ).toBeUndefined();
    expect(lockData === undefined || new TextDecoder().decode(lockData) === "").toBe(true);
    expect((await store.getClaim("stale-other-terminal"))?.status).toBe(ClaimStatus.Released);
  });
});
