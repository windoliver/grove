/**
 * Tests for grove eval command.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GroveContract } from "../../core/contract.js";
import { DefaultFrontierCalculator } from "../../core/frontier.js";
import { ContributionKind, ScoreDirection } from "../../core/models.js";
import type { OperationDeps } from "../../core/operations/deps.js";
import { makeContribution } from "../../core/test-helpers.js";
import { FsCas } from "../../local/fs-cas.js";
import {
  initSqliteDb,
  SqliteClaimStore,
  SqliteContributionStore,
} from "../../local/sqlite-store.js";
import { parseEvalArgs, runEval } from "./eval.js";

// ---------------------------------------------------------------------------
// parseEvalArgs
// ---------------------------------------------------------------------------

describe("parseEvalArgs", () => {
  test("parses a positional cid as the target", () => {
    const opts = parseEvalArgs(["blake3:abc"]);
    expect(opts.targetCid).toBe("blake3:abc");
    expect(opts.latest).toBe(false);
    expect(opts.frontierMetric).toBeUndefined();
    expect(opts.submit).toBe(false);
    expect(opts.json).toBe(false);
  });

  test("parses --frontier <metric>", () => {
    const opts = parseEvalArgs(["--frontier", "acc"]);
    expect(opts.frontierMetric).toBe("acc");
    expect(opts.targetCid).toBeUndefined();
  });

  test("parses --latest", () => {
    const opts = parseEvalArgs(["--latest"]);
    expect(opts.latest).toBe(true);
  });

  test("parses --eval-command, --submit, --timeout, --json", () => {
    const opts = parseEvalArgs([
      "blake3:abc",
      "--eval-command",
      "python eval.py",
      "--submit",
      "--timeout",
      "5000",
      "--json",
    ]);
    expect(opts.evalCommand).toBe("python eval.py");
    expect(opts.submit).toBe(true);
    expect(opts.timeoutMs).toBe(5000);
    expect(opts.json).toBe(true);
  });

  test("throws when no target selector is given", () => {
    expect(() => parseEvalArgs([])).toThrow();
  });

  test("throws when more than one target selector is given", () => {
    expect(() => parseEvalArgs(["blake3:abc", "--latest"])).toThrow();
    expect(() => parseEvalArgs(["--frontier", "acc", "--latest"])).toThrow();
  });

  test("throws on a non-numeric --timeout", () => {
    expect(() => parseEvalArgs(["blake3:abc", "--timeout", "soon"])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// runEval
// ---------------------------------------------------------------------------

describe("runEval", () => {
  let tmpDir: string;
  let store: SqliteContributionStore;
  let claimStore: SqliteClaimStore;
  let cas: FsCas;
  let baseDeps: OperationDeps;
  const agent = { agentId: "agent-eval" };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "grove-eval-test-"));
    const db = initSqliteDb(join(tmpDir, "grove.db"));
    store = new SqliteContributionStore(db);
    claimStore = new SqliteClaimStore(db);
    cas = new FsCas(join(tmpDir, "cas"));
    baseDeps = {
      contributionStore: store,
      claimStore,
      cas,
      frontier: new DefaultFrontierCalculator(store),
    };
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("evaluates an explicit cid with --eval-command and prints scores", async () => {
    const c = makeContribution({ summary: "target" });
    await store.put(c);
    const out: string[] = [];

    await runEval(
      {
        targetCid: c.cid,
        evalCommand: "echo GROVE_SCORE acc=0.9",
        latest: false,
        submit: false,
        json: false,
      },
      baseDeps,
      agent,
      (s) => out.push(s),
    );

    const text = out.join("\n");
    expect(text).toContain("acc");
    expect(text).toContain("0.9");
  });

  test("resolves --latest to the newest contribution", async () => {
    const older = makeContribution({ summary: "older", createdAt: "2026-01-01T00:00:00Z" });
    const newer = makeContribution({ summary: "newer", createdAt: "2026-02-01T00:00:00Z" });
    await store.put(older);
    await store.put(newer);
    const out: string[] = [];

    await runEval(
      { evalCommand: "echo GROVE_SCORE x=1", latest: true, submit: false, json: false },
      baseDeps,
      agent,
      (s) => out.push(s),
    );

    expect(out.join("\n")).toContain(newer.cid);
  });

  test("resolves --frontier <metric> to the leader", async () => {
    const weak = makeContribution({
      summary: "weak",
      scores: { acc: { value: 0.5, direction: ScoreDirection.Maximize } },
    });
    const strong = makeContribution({
      summary: "strong",
      scores: { acc: { value: 0.9, direction: ScoreDirection.Maximize } },
    });
    await store.put(weak);
    await store.put(strong);
    const out: string[] = [];

    await runEval(
      {
        frontierMetric: "acc",
        evalCommand: "echo GROVE_SCORE x=1",
        latest: false,
        submit: false,
        json: false,
      },
      baseDeps,
      agent,
      (s) => out.push(s),
    );

    expect(out.join("\n")).toContain(strong.cid);
  });

  test("--submit creates a reproduction carrying the parsed scores", async () => {
    const c = makeContribution({ summary: "target" });
    await store.put(c);
    const contract: GroveContract = {
      contractVersion: 2,
      name: "eval-grove",
      metrics: { acc: { direction: ScoreDirection.Maximize } },
    };
    const out: string[] = [];

    await runEval(
      {
        targetCid: c.cid,
        evalCommand: "echo GROVE_SCORE acc=0.95",
        latest: false,
        submit: true,
        json: false,
      },
      { ...baseDeps, contract },
      agent,
      (s) => out.push(s),
    );

    const all = await store.list();
    const repro = all.find((x) => x.kind === ContributionKind.Reproduction);
    expect(repro).toBeDefined();
    expect(repro?.scores?.acc?.value).toBe(0.95);
  });

  test("resolves the command from contract.hooks.eval when no --eval-command", async () => {
    const c = makeContribution({ summary: "target" });
    await store.put(c);
    const contract: GroveContract = {
      contractVersion: 2,
      name: "eval-grove",
      hooks: { eval: "echo GROVE_SCORE acc=0.7" },
    };
    const out: string[] = [];

    await runEval(
      { targetCid: c.cid, latest: false, submit: false, json: false },
      { ...baseDeps, contract },
      agent,
      (s) => out.push(s),
    );

    const text = out.join("\n");
    expect(text).toContain("acc");
    expect(text).toContain("0.7");
  });
});
