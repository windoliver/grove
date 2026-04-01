/**
 * Tests for NexusSessionStore.
 *
 * Uses MockNexusClient for in-memory VFS testing.
 */

import { describe, expect, it } from "bun:test";
import type { GroveContract } from "../core/contract.js";
import type { Session } from "../core/session-manager.js";
import { MockNexusClient } from "./mock-client.js";
import { NexusSessionStore } from "./nexus-session-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `s-${Math.random().toString(36).slice(2, 10)}`,
    goal: "Test goal",
    presetName: "test-preset",
    createdAt: new Date().toISOString(),
    status: "pending",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GroveContract> = {}): GroveContract {
  return {
    contractVersion: 3,
    name: "test-preset",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NexusSessionStore", () => {
  it("create() stores session at correct VFS path", async () => {
    const client = new MockNexusClient();
    const store = new NexusSessionStore(client, "zone-1");
    const session = makeSession({ id: "abc123" });

    await store.create(session);

    const data = await client.read(`/zones/zone-1/sessions/abc123.json`);
    expect(data).toBeDefined();
    const parsed = JSON.parse(new TextDecoder().decode(data!));
    expect(parsed.id).toBe("abc123");
    expect(parsed.goal).toBe("Test goal");
  });

  it("get() retrieves a stored session", async () => {
    const client = new MockNexusClient();
    const store = new NexusSessionStore(client, "zone-1");
    const session = makeSession({ id: "get-test" });

    await store.create(session);
    const fetched = await store.get("get-test");

    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe("get-test");
    expect(fetched!.goal).toBe("Test goal");
    expect(fetched!.presetName).toBe("test-preset");
  });

  it("get() returns undefined for missing session", async () => {
    const client = new MockNexusClient();
    const store = new NexusSessionStore(client, "zone-1");

    const fetched = await store.get("nonexistent");
    expect(fetched).toBeUndefined();
  });

  it("update() merges fields into existing session", async () => {
    const client = new MockNexusClient();
    const store = new NexusSessionStore(client, "zone-1");
    const session = makeSession({ id: "upd-test", status: "pending" });

    await store.create(session);
    await store.update("upd-test", {
      status: "running",
    });

    const fetched = await store.get("upd-test");
    expect(fetched!.status).toBe("running");
    expect(fetched!.goal).toBe("Test goal"); // Other fields preserved
  });

  it("list() returns all sessions sorted by createdAt DESC", async () => {
    const client = new MockNexusClient();
    const store = new NexusSessionStore(client, "zone-1");

    const s1 = makeSession({ id: "s1", createdAt: "2024-01-01T00:00:00.000Z" });
    const s2 = makeSession({ id: "s2", createdAt: "2024-01-02T00:00:00.000Z" });
    const s3 = makeSession({ id: "s3", createdAt: "2024-01-03T00:00:00.000Z" });

    await store.create(s1);
    await store.create(s2);
    await store.create(s3);

    const sessions = await store.list();
    expect(sessions).toHaveLength(3);
    expect(sessions[0]!.id).toBe("s3"); // Most recent first
    expect(sessions[2]!.id).toBe("s1"); // Oldest last
  });

  it("list() filters by presetName", async () => {
    const client = new MockNexusClient();
    const store = new NexusSessionStore(client, "zone-1");

    await store.create(makeSession({ id: "a1", presetName: "alpha" }));
    await store.create(makeSession({ id: "b1", presetName: "beta" }));
    await store.create(makeSession({ id: "a2", presetName: "alpha" }));

    const alphas = await store.list("alpha");
    expect(alphas).toHaveLength(2);
    expect(alphas.every((s) => s.presetName === "alpha")).toBe(true);
  });

  it("config round-trip: create with full GroveContract, get back, verify", async () => {
    const client = new MockNexusClient();
    const store = new NexusSessionStore(client, "zone-1");

    const config = makeConfig({
      mode: "evaluation",
      metrics: { val_bpb: { direction: "minimize" } },
      gates: [{ type: "metric_improves", metric: "val_bpb" }],
      topology: {
        structure: "graph",
        roles: [
          { name: "coder", description: "Write code", prompt: "Code well" },
          { name: "reviewer", description: "Review code" },
        ],
      },
    });

    const session = makeSession({ id: "cfg-test", config });
    await store.create(session);

    const fetched = await store.get("cfg-test");
    expect(fetched).toBeDefined();
    expect(fetched!.config).toBeDefined();
    expect(fetched!.config!.mode).toBe("evaluation");
    expect(fetched!.config!.metrics!.val_bpb!.direction).toBe("minimize");
    expect(fetched!.config!.gates).toHaveLength(1);
    expect(fetched!.config!.topology!.roles).toHaveLength(2);
    expect(fetched!.config!.topology!.roles[0]!.prompt).toBe("Code well");
  });
});
