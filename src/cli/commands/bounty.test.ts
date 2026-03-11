/**
 * Tests for the grove bounty command handlers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BountyStatus } from "../../core/bounty.js";
import type { BountyStore } from "../../core/bounty-store.js";
import { InMemoryCreditsService } from "../../core/in-memory-credits.js";
import type { ClaimStore } from "../../core/store.js";
import { createSqliteStores } from "../../local/sqlite-store.js";
import type { BountyDeps } from "./bounty.js";
import { runBounty } from "./bounty.js";

describe("grove bounty", () => {
  let bountyStore: BountyStore;
  let claimStore: ClaimStore;
  let creditsService: InMemoryCreditsService;
  let close: () => void;
  let tempDir: string;
  let stdout: string[];
  let stderr: string[];
  let deps: BountyDeps;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "grove-bounty-test-"));
    const stores = createSqliteStores(join(tempDir, "test.db"));
    bountyStore = stores.bountyStore;
    claimStore = stores.claimStore;
    close = stores.close;
    creditsService = new InMemoryCreditsService();
    creditsService.seed("test-agent", 10_000);
    stdout = [];
    stderr = [];
    deps = {
      bountyStore,
      creditsService,
      claimStore,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    };
  });

  afterEach(async () => {
    close();
    await rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Subcommand dispatch
  // -------------------------------------------------------------------------

  test("shows usage for unknown subcommand", async () => {
    await runBounty(["unknown"], deps);

    expect(stderr.length).toBe(1);
    expect(stderr[0]).toContain("unknown subcommand 'unknown'");
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  test("shows usage when no subcommand given", async () => {
    await runBounty([], deps);

    expect(stderr.length).toBe(1);
    expect(stderr[0]).toContain("subcommand required");
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  // -------------------------------------------------------------------------
  // grove bounty create
  // -------------------------------------------------------------------------

  describe("create", () => {
    test("creates a bounty with required args", async () => {
      await runBounty(
        [
          "create",
          "Optimize parser",
          "--amount",
          "100",
          "--deadline",
          "7d",
          "--agent-id",
          "test-agent",
        ],
        deps,
      );

      expect(stdout.length).toBe(1);
      expect(stdout[0]).toContain("Created bounty");
      expect(stdout[0]).toContain("Optimize parser");
      expect(stdout[0]).toContain("100 credits");
      expect(stdout[0]).toContain("open");
    });

    test("reserves credits on creation when creditsService provided", async () => {
      await runBounty(
        ["create", "My bounty", "--amount", "500", "--deadline", "1d", "--agent-id", "test-agent"],
        deps,
      );

      // Balance should be reduced by the reserved amount
      const balance = await creditsService.balance("test-agent");
      expect(balance.available).toBe(9_500);
    });

    test("creates bounty without credits service (local dev mode)", async () => {
      const noCreditsDeps = { ...deps, creditsService: undefined };
      await runBounty(
        ["create", "No credits", "--amount", "50", "--deadline", "1d", "--agent-id", "test-agent"],
        noCreditsDeps,
      );

      expect(stdout.length).toBe(1);
      expect(stdout[0]).toContain("Created bounty");
      expect(stdout[0]).toContain("50 credits");
    });

    test("errors when title is missing", async () => {
      await runBounty(["create", "--amount", "100", "--deadline", "7d"], deps);

      expect(stderr.length).toBe(1);
      expect(stderr[0]).toContain("title is required");
      expect(process.exitCode).toBe(2);
      process.exitCode = 0;
    });

    test("errors when --amount is missing", async () => {
      await runBounty(["create", "Title", "--deadline", "7d"], deps);

      expect(stderr.length).toBe(1);
      expect(stderr[0]).toContain("--amount is required");
      expect(process.exitCode).toBe(2);
      process.exitCode = 0;
    });

    test("errors when --deadline is missing", async () => {
      await runBounty(["create", "Title", "--amount", "100"], deps);

      expect(stderr.length).toBe(1);
      expect(stderr[0]).toContain("--deadline is required");
      expect(process.exitCode).toBe(2);
      process.exitCode = 0;
    });

    test("errors when --amount is not a positive integer", async () => {
      await runBounty(["create", "Title", "--amount", "abc", "--deadline", "1d"], deps);

      expect(stderr.length).toBe(1);
      expect(stderr[0]).toContain("positive integer");
      expect(process.exitCode).toBe(2);
      process.exitCode = 0;
    });

    test("creates bounty with criteria options", async () => {
      await runBounty(
        [
          "create",
          "ML bounty",
          "--amount",
          "300",
          "--deadline",
          "3d",
          "--criteria",
          "Reduce val_bpb below 1.5",
          "--metric-name",
          "val_bpb",
          "--metric-threshold",
          "1.5",
          "--metric-direction",
          "minimize",
          "--tags",
          "ml,optimization",
          "--agent-id",
          "test-agent",
        ],
        deps,
      );

      expect(stdout.length).toBe(1);
      expect(stdout[0]).toContain("Created bounty");
      expect(stdout[0]).toContain("300 credits");
    });
  });

  // -------------------------------------------------------------------------
  // grove bounty list
  // -------------------------------------------------------------------------

  describe("list", () => {
    test("shows message when no bounties exist", async () => {
      await runBounty(["list"], deps);

      expect(stdout.length).toBe(1);
      expect(stdout[0]).toContain("No bounties found");
    });

    test("lists created bounties", async () => {
      await runBounty(
        ["create", "Bounty A", "--amount", "100", "--deadline", "7d", "--agent-id", "test-agent"],
        deps,
      );
      await runBounty(
        ["create", "Bounty B", "--amount", "200", "--deadline", "3d", "--agent-id", "test-agent"],
        deps,
      );
      stdout = [];

      await runBounty(["list"], deps);

      expect(stdout.length).toBe(2);
      expect(stdout.some((l) => l.includes("Bounty A"))).toBe(true);
      expect(stdout.some((l) => l.includes("Bounty B"))).toBe(true);
    });

    test("filters by status", async () => {
      await runBounty(
        [
          "create",
          "Open bounty",
          "--amount",
          "100",
          "--deadline",
          "7d",
          "--agent-id",
          "test-agent",
        ],
        deps,
      );
      stdout = [];

      await runBounty(["list", "--status", "open"], deps);
      expect(stdout.length).toBe(1);
      expect(stdout[0]).toContain("Open bounty");

      stdout = [];
      await runBounty(["list", "--status", "settled"], deps);
      expect(stdout.length).toBe(1);
      expect(stdout[0]).toContain("No bounties found");
    });
  });

  // -------------------------------------------------------------------------
  // grove bounty claim
  // -------------------------------------------------------------------------

  describe("claim", () => {
    test("claims an open bounty", async () => {
      await runBounty(
        ["create", "Claimable", "--amount", "100", "--deadline", "7d", "--agent-id", "test-agent"],
        deps,
      );

      // Get bounty ID from the store
      const bounties = await bountyStore.listBounties({ status: BountyStatus.Open });
      const bountyId = bounties[0]?.bountyId as string;
      stdout = [];

      await runBounty(["claim", bountyId, "--agent-id", "claimer-agent"], deps);

      expect(stdout.length).toBe(1);
      expect(stdout[0]).toContain("Claimed bounty");
      expect(stdout[0]).toContain("claimed");
      expect(stdout[0]).toContain("claimer-agent");
    });

    test("errors when bounty-id is missing", async () => {
      await runBounty(["claim"], deps);

      expect(stderr.length).toBe(1);
      expect(stderr[0]).toContain("bounty-id is required");
      expect(process.exitCode).toBe(2);
      process.exitCode = 0;
    });

    test("errors when bounty does not exist", async () => {
      await runBounty(["claim", "nonexistent-id"], deps);

      expect(stderr.length).toBe(1);
      expect(stderr[0]).toContain("not found");
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    });

    test("errors when bounty is not open", async () => {
      await runBounty(
        [
          "create",
          "Claimed bounty",
          "--amount",
          "100",
          "--deadline",
          "7d",
          "--agent-id",
          "test-agent",
        ],
        deps,
      );

      const bounties = await bountyStore.listBounties({ status: BountyStatus.Open });
      const bountyId = bounties[0]?.bountyId as string;

      // First claim succeeds
      await runBounty(["claim", bountyId, "--agent-id", "claimer-1"], deps);
      stderr = [];

      // Second claim on already-claimed bounty fails
      await runBounty(["claim", bountyId, "--agent-id", "claimer-2"], deps);

      expect(stderr.length).toBe(1);
      expect(stderr[0]).toContain("not open");
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    });
  });
});
