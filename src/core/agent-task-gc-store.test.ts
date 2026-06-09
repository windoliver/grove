import { describe, expect, test } from "bun:test";
import { createSqliteStores } from "../local/sqlite-store.js";
import type { AgentTaskSpecRecord } from "./agent-task.js";
import { AgentTaskGcStore, CompositeGcStore } from "./agent-task-gc-store.js";
import { expectOk } from "./cas.js";
import type { GcStore } from "./garbage-collector.js";
import { GarbageCollector } from "./garbage-collector.js";
import { InMemoryGcStore } from "./in-memory-gc-store.js";
import { KindFinalizer, PropagationFinalizer } from "./lifecycle-metadata.js";
import type { GcRef } from "./owner-graph.js";

function spec(id: string, over: Partial<AgentTaskSpecRecord> = {}): AgentTaskSpecRecord {
  return {
    id,
    worktree: "/wt",
    runtime: "claude",
    role: "coder",
    prompt: "go",
    dependsOn: [],
    generation: 1,
    createdAt: "2026-06-08T00:00:00.000Z",
    ...over,
  };
}

async function drain(gc: GarbageCollector, refs: GcRef[], probe: () => Promise<readonly GcRef[]>) {
  for (let pass = 0; pass < 50; pass += 1) {
    const dynamic = await probe();
    const all = new Map<string, GcRef>();
    for (const r of [...refs, ...dynamic]) all.set(`${r.kind}:${r.id}`, r);
    for (const ref of all.values()) await gc.reconcileNode(ref);
  }
}

describe("AgentTaskGcStore over real Sqlite", () => {
  test("pending-review finalizer blocks reap until removed", async () => {
    const stores = createSqliteStores(":memory:");
    try {
      const store = new AgentTaskGcStore(stores.agentTaskStore);
      expectOk(
        await stores.agentTaskStore.putAgentTaskSpec(
          spec("at-1", { finalizers: [KindFinalizer.PendingReview] }),
        ),
      );
      expectOk(
        await stores.agentTaskStore.setAgentTaskDeletion("at-1", "2026-06-08T01:00:00.000Z"),
      );

      const gc = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T02:00:00.000Z") });
      const ref: GcRef = { kind: "agentTask", id: "at-1" };
      await drain(gc, [ref], async () => []);
      expect(await store.getNode(ref)).toBeDefined(); // blocked

      await store.removeFinalizer(ref, KindFinalizer.PendingReview);
      await drain(gc, [ref], async () => []);
      expect(await store.getNode(ref)).toBeUndefined(); // reaped
    } finally {
      stores.close();
    }
  });

  test("Foreground cascade: delete TaskGroup reaps real AgentTask children", async () => {
    const stores = createSqliteStores(":memory:");
    try {
      // TaskGroup owner lives in-memory; AgentTask children live in Sqlite.
      const tgStore = new InMemoryGcStore();
      tgStore.put({
        kind: "taskGroup",
        id: "tg",
        uid: "u-tg",
        ownerRefs: [],
        finalizers: [PropagationFinalizer.Foreground],
        deletionTimestamp: "2026-06-08T00:00:00.000Z",
      });
      expectOk(
        await stores.agentTaskStore.putAgentTaskSpec(
          spec("at-c", {
            ownerRef: { kind: "taskGroup", id: "tg", uid: "u-tg", controller: true },
          }),
        ),
      );

      const composite = new CompositeGcStore(
        new Map<GcRef["kind"], GcStore>([
          ["taskGroup", tgStore],
          ["agentTask", new AgentTaskGcStore(stores.agentTaskStore)],
        ]),
      );
      const gc = new GarbageCollector({
        store: composite,
        now: () => Date.parse("2026-06-08T03:00:00.000Z"),
      });

      const tg: GcRef = { kind: "taskGroup", id: "tg" };
      const child: GcRef = { kind: "agentTask", id: "at-c" };
      await drain(gc, [tg, child], async () =>
        (await composite.listPendingDeletion()).map((n) => ({ kind: n.kind, id: n.id })),
      );

      expect(await stores.agentTaskStore.getAgentTask("at-c")).toBeUndefined(); // child reaped
      expect(tgStore.has(tg)).toBe(false); // owner reaped
    } finally {
      stores.close();
    }
  });
});
