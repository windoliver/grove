import { describe, expect, test } from "bun:test";
import { HandoffStatus } from "../core/handoff.js";
import { MockNexusClient } from "../nexus/mock-client.js";
import { createNexusHandoffStores } from "./handoff-store-wiring.js";

describe("server Nexus handoff store wiring", () => {
  test("uses Nexus-backed stores for both global and session-scoped handoff reads", async () => {
    const client = new MockNexusClient();
    const stores = createNexusHandoffStores(client, "zone-a");

    const scoped = stores.handoffStoreForSession("session-a");
    await scoped.create({
      sourceCid: "blake3:work",
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });
    const created = await scoped.list();
    const handoff = created[0];
    if (handoff === undefined) throw new Error("expected scoped handoff to be created");
    await scoped.markReplied(handoff.handoffId, "blake3:review");

    const global = await stores.handoffStore.list();
    expect(global).toHaveLength(1);
    expect(global[0]?.status).toBe(HandoffStatus.Replied);

    const sameSession = await stores.handoffStoreForSession("session-a").list();
    expect(sameSession).toHaveLength(1);
    expect(sameSession[0]?.status).toBe(HandoffStatus.Replied);

    const otherSession = await stores.handoffStoreForSession("session-b").list();
    expect(otherSession).toHaveLength(0);
  });
});
