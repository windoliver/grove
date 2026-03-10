/**
 * Tests for the grove import CLI command argument parsing.
 */

import { describe, expect, test } from "bun:test";
import { parseImportArgs } from "./import.js";

describe("parseImportArgs", () => {
  test("parses --from-pr with owner/repo#number", () => {
    const opts = parseImportArgs(["--from-pr", "windoliver/myproject#44"]);
    expect(opts.fromPR).toBe(true);
    expect(opts.fromDiscussion).toBe(false);
    expect(opts.ref).toBe("windoliver/myproject#44");
  });

  test("parses --from-discussion with owner/repo#number", () => {
    const opts = parseImportArgs(["--from-discussion", "windoliver/myproject#43"]);
    expect(opts.fromDiscussion).toBe(true);
    expect(opts.fromPR).toBe(false);
    expect(opts.ref).toBe("windoliver/myproject#43");
  });

  test("throws when neither --from-pr nor --from-discussion", () => {
    expect(() => parseImportArgs(["owner/repo#1"])).toThrow(/--from-pr or --from-discussion/);
  });

  test("throws when both --from-pr and --from-discussion", () => {
    expect(() => parseImportArgs(["--from-pr", "--from-discussion", "owner/repo#1"])).toThrow(
      /only one/,
    );
  });

  test("throws when missing ref argument", () => {
    expect(() => parseImportArgs(["--from-pr"])).toThrow(/Usage/);
  });

  test("validates PR ref format", () => {
    expect(() => parseImportArgs(["--from-pr", "invalid"])).toThrow(/owner\/repo#number/);
  });

  test("validates Discussion ref format", () => {
    expect(() => parseImportArgs(["--from-discussion", "nohash"])).toThrow(/owner\/repo#number/);
  });

  test("validates PR number is positive", () => {
    expect(() => parseImportArgs(["--from-pr", "owner/repo#0"])).toThrow(/positive integer/);
  });
});

describe("handleImport", () => {
  test("--help prints usage without requiring other args", async () => {
    const { handleImport } = await import("./import.js");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await handleImport(["--help"]);
      expect(logs.some((l) => l.includes("grove import"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });
});
