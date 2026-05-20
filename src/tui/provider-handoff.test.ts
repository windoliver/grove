import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import { HandoffStatus } from "../core/handoff.js";
import { createSqliteStores } from "../local/sqlite-store.js";
import { LocalDataProvider } from "./local-provider.js";
import { isHandoffProvider } from "./provider.js";

describe("TUI handoff provider actions", () => {
  let tempDir: string;
  let stores: ReturnType<typeof createSqliteStores>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-handoff-provider-test-"));
    stores = createSqliteStores(join(tempDir, "grove.db"));
  });

  afterEach(() => {
    stores.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeProvider(): LocalDataProvider {
    return new LocalDataProvider({
      contributionStore: stores.contributionStore,
      claimStore: stores.claimStore,
      frontier: new DefaultFrontierCalculator(stores.contributionStore),
      groveName: "test",
      handoffStore: stores.handoffStore,
    });
  }

  test("requires action methods for the handoff provider type guard", () => {
    const partialProvider = {
      getHandoffs: async () => [],
      markHandoffDelivered: async () => undefined,
    };

    expect(isHandoffProvider(partialProvider)).toBe(false);
    expect(isHandoffProvider(makeProvider())).toBe(true);
  });

  test("provider without handoff store is not actionable and throws clear errors", async () => {
    const provider = new LocalDataProvider({
      contributionStore: stores.contributionStore,
      claimStore: stores.claimStore,
      frontier: new DefaultFrontierCalculator(stores.contributionStore),
      groveName: "test",
    });

    expect(isHandoffProvider(provider)).toBe(false);
    await expect(provider.cancelHandoff("missing")).rejects.toThrow("Handoff store not configured");
  });

  test("store-backed replacement actions reject missing originals", async () => {
    const provider = makeProvider();

    await expect(provider.resendHandoff("missing")).rejects.toThrow("Handoff not found: missing");
    await expect(provider.rerouteHandoff("missing", { toRole: "auditor" })).rejects.toThrow(
      "Handoff not found: missing",
    );
  });

  test("store-backed terminal actions update handoff status and reason", async () => {
    const provider = makeProvider();
    const cancelled = await stores.handoffStore.create({
      handoffId: "handoff-cancel",
      sourceCid: "blake3:source-cancel",
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
    });
    const resolved = await stores.handoffStore.create({
      handoffId: "handoff-resolve",
      sourceCid: "blake3:source-resolve",
      fromRole: "tester",
      toRole: "coder",
      requiresReply: true,
    });
    await stores.handoffStore.markDeadLettered(resolved.handoffId);

    await provider.cancelHandoff(cancelled.handoffId, "operator selected cancel");
    await provider.manualResolveHandoff(resolved.handoffId, "handled out of band");

    const storedCancelled = await stores.handoffStore.get(cancelled.handoffId);
    const storedResolved = await stores.handoffStore.get(resolved.handoffId);
    expect(storedCancelled?.status).toBe(HandoffStatus.Cancelled);
    expect(storedCancelled?.terminalReason).toBe("operator selected cancel");
    expect(storedResolved?.status).toBe(HandoffStatus.ManuallyResolved);
    expect(storedResolved?.terminalReason).toBe("handled out of band");
  });

  test("store-backed replacement actions create linked replacements", async () => {
    const provider = makeProvider();
    const originalDueAt = "2099-01-01T00:00:00.000Z";
    const overrideDueAt = "2099-02-01T00:00:00.000Z";
    const resend = await stores.handoffStore.create({
      handoffId: "handoff-resend",
      sourceCid: "blake3:source-resend",
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
      replyDueAt: originalDueAt,
    });
    const reroute = await stores.handoffStore.create({
      handoffId: "handoff-reroute",
      sourceCid: "blake3:source-reroute",
      fromRole: "coder",
      toRole: "reviewer",
      requiresReply: true,
      replyDueAt: originalDueAt,
    });
    await stores.handoffStore.markDeadLettered(resend.handoffId);
    await stores.handoffStore.markDeadLettered(reroute.handoffId);

    await provider.resendHandoff(resend.handoffId, { reason: "retry delivery" });
    await provider.rerouteHandoff(reroute.handoffId, {
      toRole: "auditor",
      reason: "needs audit",
      replyDueAt: overrideDueAt,
    });

    const storedResend = await stores.handoffStore.get(resend.handoffId);
    const resendReplacementId = storedResend?.replacementHandoffId;
    if (resendReplacementId === undefined) {
      throw new Error("resend replacement id was not recorded");
    }
    const resendReplacement = await stores.handoffStore.get(resendReplacementId);
    expect(storedResend?.status).toBe(HandoffStatus.Cancelled);
    expect(storedResend?.terminalReason).toBe("retry delivery");
    expect(resendReplacement).toMatchObject({
      sourceCid: resend.sourceCid,
      fromRole: resend.fromRole,
      toRole: resend.toRole,
      status: HandoffStatus.PendingPickup,
      requiresReply: true,
      replyDueAt: originalDueAt,
    });

    const storedReroute = await stores.handoffStore.get(reroute.handoffId);
    const rerouteReplacementId = storedReroute?.replacementHandoffId;
    if (rerouteReplacementId === undefined) {
      throw new Error("reroute replacement id was not recorded");
    }
    const rerouteReplacement = await stores.handoffStore.get(rerouteReplacementId);
    expect(storedReroute?.status).toBe(HandoffStatus.Cancelled);
    expect(storedReroute?.terminalReason).toBe("needs audit");
    expect(rerouteReplacement).toMatchObject({
      sourceCid: reroute.sourceCid,
      fromRole: reroute.fromRole,
      toRole: "auditor",
      status: HandoffStatus.PendingPickup,
      requiresReply: true,
      replyDueAt: overrideDueAt,
    });
  });
});
