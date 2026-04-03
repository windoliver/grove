/**
 * Tests for NexusSessionStore.
 *
 * Uses an in-memory mock NexusClient to test session CRUD operations
 * without a real Nexus server.
 */

import { describe, expect, it } from "bun:test";
import type { Session } from "../core/session.js";
import type { NexusClient } from "./client.js";
import { NexusSessionStore } from "./nexus-session-store.js";

// ---------------------------------------------------------------------------
// Mock NexusClient
// ---------------------------------------------------------------------------

function createMockClient(): NexusClient {
  const files = new Map<string, Uint8Array>();
  const _encoder = new TextEncoder();

  return {
    read: async (path: string) => files.get(path) ?? null,
    write: async (path: string, data: Uint8Array) => {
      files.set(path, data);
    },
    exists: async (path: string) => files.has(path),
    list: async (dir: string) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const result: { name: string; size: number }[] = [];
      for (const [path, data] of files) {
        if (path.startsWith(prefix)) {
          const name = path.slice(prefix.length);
          if (!name.includes("/")) {
            result.push({ name, size: data.byteLength });
          }
        }
      }
      return { files: result };
    },
    delete: async (path: string) => {
      files.delete(path);
    },
    mkdir: async () => {},
  } as unknown as NexusClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NexusSessionStore", () => {
  it("createSession() returns a session with generated ID", async () => {
    const client = createMockClient();
    const store = new NexusSessionStore(client, "test-zone");
    const session = await store.createSession({ goal: "Test goal" });

    expect(session.id).toBeTruthy();
    expect(session.goal).toBe("Test goal");
    expect(session.status).toBe("active");
    expect(session.contributionCount).toBe(0);
  });

  it("getSession() retrieves created session", async () => {
    const client = createMockClient();
    const store = new NexusSessionStore(client, "test-zone");
    const created = await store.createSession({ goal: "Fetch test" });

    const fetched = await store.getSession(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.goal).toBe("Fetch test");
  });

  it("getSession() returns undefined for missing ID", async () => {
    const client = createMockClient();
    const store = new NexusSessionStore(client, "test-zone");
    const fetched = await store.getSession("nonexistent");
    expect(fetched).toBeUndefined();
  });

  it("putSession() stores an existing session record", async () => {
    const client = createMockClient();
    const store = new NexusSessionStore(client, "test-zone");
    const session: Session = {
      id: "put-test",
      goal: "Put test",
      status: "active",
      createdAt: new Date().toISOString(),
      contributionCount: 0,
    };
    await store.putSession(session);

    const fetched = await store.getSession("put-test");
    expect(fetched).toBeDefined();
    expect(fetched!.goal).toBe("Put test");
  });

  it("config field survives JSON round-trip through NexusSessionStore", async () => {
    const client = createMockClient();
    const store = new NexusSessionStore(client, "test-zone");
    const config = {
      contractVersion: 3,
      name: "nexus-config",
      mode: "evaluation" as const,
    };
    const session = await store.createSession({
      goal: "Config test",
      config: config as import("../core/contract.js").GroveContract,
    });

    const fetched = await store.getSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched!.config).toBeDefined();
    expect(fetched!.config?.name).toBe("nexus-config");
  });

  it("listSessions() returns sessions sorted by createdAt descending", async () => {
    const client = createMockClient();
    const store = new NexusSessionStore(client, "test-zone");
    await store.createSession({ goal: "First" });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await store.createSession({ goal: "Second" });

    const sessions = await store.listSessions();
    expect(sessions.length).toBe(2);
    expect(sessions[0]?.goal).toBe("Second");
    expect(sessions[1]?.goal).toBe("First");
  });

  it("archiveSession() changes status to archived", async () => {
    const client = createMockClient();
    const store = new NexusSessionStore(client, "test-zone");
    const session = await store.createSession({ goal: "Archive test" });
    await store.archiveSession(session.id);

    const fetched = await store.getSession(session.id);
    expect(fetched!.status).toBe("archived");
    expect(fetched!.completedAt).toBeDefined();
  });
});
