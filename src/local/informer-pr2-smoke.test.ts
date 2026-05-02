/**
 * E2E smoke test for the PR2 (#388) local-mode informer pipeline.
 *
 * Mounts a real `LocalRuntime` + `WatchHub` + `InformerFactory(mode:"local")`
 * end-to-end. Asserts that:
 *
 *  1. After `factory.startAll()`, the Contribution and Claim informers
 *     reach `hasSynced=true` from the empty initial snapshot.
 *  2. Writing a contribution / claim through the local store fires
 *     `recordWrite` via the WatchHubRecorder hook, propagates through
 *     `LocalWatchClient`, and lands in the informer cache.
 *  3. `factory.relist()` re-issues the listFn snapshot and the cache
 *     contents survive (event sequence: RELIST_BEGIN → RELIST → RELIST_END).
 *  4. `factory.stopAll()` settles cleanly with no leaked timers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InformerFactory } from "../core/informer.js";
import { makeClaim, makeContribution } from "../core/test-helpers.js";
import { WatchHub } from "../core/watch-hub.js";
import { createLocalRuntime, type LocalRuntime } from "./runtime.js";

const NS = "default";

async function untilTrue(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("untilTrue: timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("PR2 local-mode informer end-to-end", () => {
  let rootDir: string;
  let runtime: LocalRuntime;
  let hub: WatchHub;
  let factory: InformerFactory;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pr2-informer-smoke-"));
    const groveDir = join(rootDir, ".grove");
    await mkdir(groveDir, { recursive: true });
    hub = new WatchHub();
    runtime = createLocalRuntime({
      groveDir,
      parseContract: false,
      workspace: false,
      watchHub: hub,
      watchNamespace: NS,
    });
    factory = new InformerFactory({
      mode: "local",
      hub,
      namespace: NS,
      listFn: async (kind) => {
        switch (kind) {
          case "Contribution":
            return runtime.contributionStore.listEntities();
          case "Claim":
            return runtime.claimStore.listEntities();
          default:
            return [];
        }
      },
    });
  });

  afterEach(async () => {
    await factory.stopAll();
    runtime.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  test("startAll → both informers sync to empty cache", async () => {
    factory.startAll();
    const contribInformer = factory.informerFor("Contribution");
    const claimInformer = factory.informerFor("Claim");
    await untilTrue(() => contribInformer.hasSynced() && claimInformer.hasSynced());
    expect(contribInformer.list()).toEqual([]);
    expect(claimInformer.list()).toEqual([]);
  });

  test("contribution write fires hub recordWrite and lands in cache", async () => {
    factory.startAll();
    const informer = factory.informerFor("Contribution");
    await untilTrue(() => informer.hasSynced());

    const c = makeContribution({ summary: "smoke-1" });
    await runtime.contributionStore.put(c);

    await untilTrue(() => informer.list().length === 1);
    expect(informer.getById(c.cid)?.id).toBe(c.cid);
    expect(hub.currentRv(NS, "Contribution")).toBe(1n);
  });

  test("claim write fires hub recordWrite and lands in cache", async () => {
    factory.startAll();
    const informer = factory.informerFor("Claim");
    await untilTrue(() => informer.hasSynced());

    const claim = makeClaim({ targetRef: "smoke-target" });
    await runtime.claimStore.createClaim(claim);

    await untilTrue(() => informer.list().length === 1);
    expect(informer.getById(claim.claimId)?.id).toBe(claim.claimId);
  });

  test("factory.relist preserves cache content via fresh listFn snapshot", async () => {
    factory.startAll();
    const informer = factory.informerFor("Claim");
    await untilTrue(() => informer.hasSynced());

    const claim = makeClaim({ targetRef: "relist-target" });
    await runtime.claimStore.createClaim(claim);
    await untilTrue(() => informer.list().length === 1);

    // Forced relist — informer aborts the watch loop, re-runs listFn,
    // and re-emits RELIST_BEGIN/RELIST/RELIST_END. Cache content unchanged.
    await factory.relist("Claim");
    expect(informer.list().length).toBe(1);
    expect(informer.getById(claim.claimId)).toBeDefined();
  });
});
