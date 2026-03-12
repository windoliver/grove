/**
 * Tests for grove checkout command.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import { ScoreDirection } from "../../core/models.js";
import { makeContribution } from "../../core/test-helpers.js";
import { FsCas } from "../../local/fs-cas.js";
import {
  initSqliteDb,
  SqliteClaimStore,
  SqliteContributionStore,
} from "../../local/sqlite-store.js";
import type { CliDeps } from "../context.js";
import { parseCheckoutArgs, runCheckout } from "./checkout.js";

let tmpDir: string;
let deps: CliDeps;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grove-checkout-test-"));
  const groveDir = join(tmpDir, ".grove");
  await mkdir(groveDir, { recursive: true });

  const db = initSqliteDb(join(groveDir, "grove.db"));
  const store = new SqliteContributionStore(db);
  const claimStore = new SqliteClaimStore(db);
  const cas = new FsCas(join(groveDir, "cas"));
  const frontier = new DefaultFrontierCalculator(store);

  deps = {
    store,
    claimStore,
    frontier,
    workspace: undefined as never, // checkout no longer uses workspace manager
    cas,
    groveRoot: tmpDir,
    close: () => {
      store.close();
    },
  };
});

afterEach(async () => {
  deps.close();
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseCheckoutArgs
// ---------------------------------------------------------------------------

describe("parseCheckoutArgs", () => {
  test("parses CID + --to", () => {
    const opts = parseCheckoutArgs(["blake3:abc123", "--to", "./workspace"]);
    expect(opts.cid).toBe("blake3:abc123");
    expect(opts.to).toBe("./workspace");
    expect(opts.frontierMetric).toBeUndefined();
  });

  test("parses --frontier + --to", () => {
    const opts = parseCheckoutArgs(["--frontier", "throughput", "--to", "./ws"]);
    expect(opts.frontierMetric).toBe("throughput");
    expect(opts.cid).toBeUndefined();
  });

  test("rejects missing --to", () => {
    expect(() => parseCheckoutArgs(["blake3:abc123"])).toThrow("Missing required --to");
  });

  test("rejects neither CID nor --frontier", () => {
    expect(() => parseCheckoutArgs(["--to", "./ws"])).toThrow(
      "Provide a CID positional argument or --frontier",
    );
  });

  test("rejects both CID and --frontier", () => {
    expect(() => parseCheckoutArgs(["blake3:abc123", "--frontier", "tp", "--to", "./ws"])).toThrow(
      "Provide either a CID or --frontier, not both",
    );
  });
});

// ---------------------------------------------------------------------------
// runCheckout
// ---------------------------------------------------------------------------

describe("runCheckout", () => {
  test("checks out artifacts to the --to directory", async () => {
    const data = new TextEncoder().encode("hello world");
    const hash = await deps.cas.put(data);

    const c = makeContribution({
      summary: "test checkout",
      artifacts: { "readme.txt": hash },
    });
    await deps.store.put(c);

    const outDir = join(tmpDir, "requested-output");
    const output: string[] = [];
    await runCheckout({ cid: c.cid, to: outDir, agent: "test-agent" }, deps, (s) => output.push(s));

    // Verify the file actually exists in the requested --to directory
    const destFile = join(outDir, "readme.txt");
    expect(existsSync(destFile)).toBe(true);
    const content = await readFile(destFile, "utf-8");
    expect(content).toBe("hello world");

    const text = output.join("\n");
    expect(text).toContain("Checked out");
    expect(text).toContain(outDir);
    expect(text).toContain("test checkout");
    expect(text).toContain("Artifacts: 1");
  });

  test("checks out nested artifacts", async () => {
    const data = new TextEncoder().encode("nested content");
    const hash = await deps.cas.put(data);

    const c = makeContribution({
      summary: "nested test",
      artifacts: { "src/main.py": hash },
    });
    await deps.store.put(c);

    const outDir = join(tmpDir, "nested-out");
    await runCheckout({ cid: c.cid, to: outDir, agent: "test-agent" }, deps);

    const destFile = join(outDir, "src", "main.py");
    expect(existsSync(destFile)).toBe(true);
    const content = await readFile(destFile, "utf-8");
    expect(content).toBe("nested content");
  });

  test("resolves CID from frontier metric", async () => {
    const c = makeContribution({
      summary: "best model",
      scores: { throughput: { value: 100, direction: ScoreDirection.Maximize } },
    });
    await deps.store.put(c);

    const outDir = join(tmpDir, "frontier-out");
    const output: string[] = [];
    await runCheckout(
      { frontierMetric: "throughput", to: outDir, agent: "test-agent" },
      deps,
      (s) => output.push(s),
    );

    const text = output.join("\n");
    expect(text).toContain("Resolved frontier best");
    expect(text).toContain("best model");
  });

  test("re-checkout removes stale files from previous checkout", async () => {
    const dataV1 = new TextEncoder().encode("version 1");
    const hashV1 = await deps.cas.put(dataV1);

    const c1 = makeContribution({
      summary: "v1",
      artifacts: { "model.bin": hashV1, "stale-file.txt": hashV1 },
    });
    await deps.store.put(c1);

    const outDir = join(tmpDir, "reuse-dir");
    await runCheckout({ cid: c1.cid, to: outDir, agent: "test-agent" }, deps);
    expect(existsSync(join(outDir, "stale-file.txt"))).toBe(true);

    // Second contribution has only model.bin — stale-file.txt should disappear
    const dataV2 = new TextEncoder().encode("version 2");
    const hashV2 = await deps.cas.put(dataV2);

    const c2 = makeContribution({
      summary: "v2",
      artifacts: { "model.bin": hashV2 },
      createdAt: "2026-01-02T00:00:00Z",
    });
    await deps.store.put(c2);

    await runCheckout({ cid: c2.cid, to: outDir, agent: "test-agent" }, deps);

    // stale-file.txt must be gone
    expect(existsSync(join(outDir, "stale-file.txt"))).toBe(false);
    // model.bin should have the new content
    const content = await readFile(join(outDir, "model.bin"), "utf-8");
    expect(content).toBe("version 2");
  });

  test("missing CAS artifact leaves destination untouched (atomic staging)", async () => {
    const goodData = new TextEncoder().encode("good artifact");
    const goodHash = await deps.cas.put(goodData);

    // A contribution that references a valid artifact and a bogus one
    const badHash = "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const c = makeContribution({
      summary: "partial",
      artifacts: { "good.txt": goodHash, "missing.txt": badHash },
    });
    await deps.store.put(c);

    // Pre-populate destination with existing content that should survive
    const outDir = join(tmpDir, "atomic-test");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "existing.txt"), "do not lose me");

    await expect(
      runCheckout({ cid: c.cid, to: outDir, agent: "test-agent" }, deps),
    ).rejects.toThrow("not found in CAS");

    // Destination should be untouched — existing.txt still there, no partial good.txt
    expect(existsSync(join(outDir, "existing.txt"))).toBe(true);
    const preserved = await readFile(join(outDir, "existing.txt"), "utf-8");
    expect(preserved).toBe("do not lose me");
    expect(existsSync(join(outDir, "good.txt"))).toBe(false);
  });

  test("throws for missing contribution", async () => {
    const badCid = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
    await expect(
      runCheckout({ cid: badCid, to: join(tmpDir, "out"), agent: "test-agent" }, deps),
    ).rejects.toThrow("not found");
  });

  test("throws for missing frontier metric", async () => {
    await expect(
      runCheckout(
        { frontierMetric: "nonexistent", to: join(tmpDir, "out"), agent: "test-agent" },
        deps,
      ),
    ).rejects.toThrow("No frontier entries");
  });
});
