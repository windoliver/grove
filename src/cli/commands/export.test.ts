/**
 * Tests for the grove export CLI command argument parsing.
 */

import { describe, expect, test } from "bun:test";
import { parseExportArgs } from "./export.js";

describe("parseExportArgs", () => {
  test("parses --to-discussion with repo and CID", () => {
    const opts = parseExportArgs([
      "--to-discussion",
      "windoliver/grove",
      "blake3:abc123def456abc123def456abc123def456abc123def456abc123def456abcd1234",
    ]);
    expect(opts.toDiscussion).toBe(true);
    expect(opts.toPR).toBe(false);
    expect(opts.repoRef).toBe("windoliver/grove");
    expect(opts.cid).toContain("blake3:");
    expect(opts.category).toBe("General");
  });

  test("parses --to-pr with repo and CID", () => {
    const opts = parseExportArgs([
      "--to-pr",
      "windoliver/grove",
      "blake3:abc123def456abc123def456abc123def456abc123def456abc123def456abcd1234",
    ]);
    expect(opts.toPR).toBe(true);
    expect(opts.toDiscussion).toBe(false);
  });

  test("parses --category override", () => {
    const opts = parseExportArgs([
      "--to-discussion",
      "owner/repo",
      "blake3:abc123def456abc123def456abc123def456abc123def456abc123def456abcd1234",
      "--category",
      "Ideas",
    ]);
    expect(opts.category).toBe("Ideas");
  });

  test("throws when neither --to-discussion nor --to-pr", () => {
    expect(() => parseExportArgs(["owner/repo", "blake3:abc"])).toThrow(
      /--to-discussion or --to-pr/,
    );
  });

  test("throws when both --to-discussion and --to-pr", () => {
    expect(() =>
      parseExportArgs(["--to-discussion", "--to-pr", "owner/repo", "blake3:abc"]),
    ).toThrow(/only one/);
  });

  test("throws when missing positional args", () => {
    expect(() => parseExportArgs(["--to-discussion"])).toThrow(/Usage/);
  });

  test("throws when only repo is given (missing CID)", () => {
    expect(() => parseExportArgs(["--to-discussion", "owner/repo"])).toThrow(/Usage/);
  });

  test("validates repo ref format", () => {
    expect(() => parseExportArgs(["--to-discussion", "invalid", "blake3:abc"])).toThrow(
      /owner\/repo/,
    );
  });
});

describe("handleExport", () => {
  test("--help prints usage without requiring other args", async () => {
    const { handleExport } = await import("./export.js");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await handleExport(["--help"]);
      expect(logs.some((l) => l.includes("grove export"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });
});
