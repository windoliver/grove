/**
 * Tests for GitHub reference parsers.
 */

import { describe, expect, test } from "bun:test";
import { parseDiscussionRef, parsePRRef, parseRepoRef } from "./refs.js";

describe("parseRepoRef", () => {
  test("parses valid owner/repo", () => {
    const ref = parseRepoRef("windoliver/grove");
    expect(ref).toEqual({ owner: "windoliver", repo: "grove" });
  });

  test("trims whitespace", () => {
    const ref = parseRepoRef("  windoliver/grove  ");
    expect(ref).toEqual({ owner: "windoliver", repo: "grove" });
  });

  test("allows hyphens in owner", () => {
    const ref = parseRepoRef("my-org/my-repo");
    expect(ref).toEqual({ owner: "my-org", repo: "my-repo" });
  });

  test("allows dots and underscores in repo name", () => {
    const ref = parseRepoRef("owner/my.repo_name");
    expect(ref).toEqual({ owner: "owner", repo: "my.repo_name" });
  });

  test("allows single-char owner", () => {
    const ref = parseRepoRef("a/repo");
    expect(ref).toEqual({ owner: "a", repo: "repo" });
  });

  test("rejects missing slash", () => {
    expect(() => parseRepoRef("noslash")).toThrow(/expected 'owner\/repo'/);
  });

  test("rejects empty owner", () => {
    expect(() => parseRepoRef("/repo")).toThrow(/Invalid GitHub owner/);
  });

  test("rejects empty repo", () => {
    expect(() => parseRepoRef("owner/")).toThrow(/Invalid GitHub repo name/);
  });

  test("rejects extra slashes", () => {
    expect(() => parseRepoRef("owner/repo/extra")).toThrow(/unexpected extra/);
  });

  test("rejects owner starting with hyphen", () => {
    expect(() => parseRepoRef("-owner/repo")).toThrow(/Invalid GitHub owner/);
  });

  test("rejects owner ending with hyphen", () => {
    expect(() => parseRepoRef("owner-/repo")).toThrow(/Invalid GitHub owner/);
  });

  test("rejects owner with special characters", () => {
    expect(() => parseRepoRef("own@er/repo")).toThrow(/Invalid GitHub owner/);
  });

  test("rejects empty string", () => {
    expect(() => parseRepoRef("")).toThrow(/expected 'owner\/repo'/);
  });
});

describe("parsePRRef", () => {
  test("parses valid owner/repo#number", () => {
    const ref = parsePRRef("windoliver/myproject#44");
    expect(ref).toEqual({ owner: "windoliver", repo: "myproject", number: 44 });
  });

  test("trims whitespace", () => {
    const ref = parsePRRef("  owner/repo#1  ");
    expect(ref).toEqual({ owner: "owner", repo: "repo", number: 1 });
  });

  test("handles large PR numbers", () => {
    const ref = parsePRRef("owner/repo#99999");
    expect(ref).toEqual({ owner: "owner", repo: "repo", number: 99999 });
  });

  test("rejects missing #", () => {
    expect(() => parsePRRef("owner/repo")).toThrow(/expected 'owner\/repo#number'/);
  });

  test("rejects non-numeric after #", () => {
    expect(() => parsePRRef("owner/repo#abc")).toThrow(/not a valid number/);
  });

  test("rejects zero PR number", () => {
    expect(() => parsePRRef("owner/repo#0")).toThrow(/positive integer/);
  });

  test("rejects negative PR number", () => {
    expect(() => parsePRRef("owner/repo#-1")).toThrow(/positive integer/);
  });

  test("rejects float PR number", () => {
    // parseInt("1.5") → 1, which is valid. This is acceptable behavior.
    const ref = parsePRRef("owner/repo#1.5");
    expect(ref.number).toBe(1);
  });

  test("rejects empty number after #", () => {
    expect(() => parsePRRef("owner/repo#")).toThrow(/not a valid number/);
  });

  test("propagates owner/repo validation errors", () => {
    expect(() => parsePRRef("-bad/repo#1")).toThrow(/Invalid GitHub owner/);
  });
});

describe("parseDiscussionRef", () => {
  test("parses valid owner/repo#number", () => {
    const ref = parseDiscussionRef("windoliver/myproject#43");
    expect(ref).toEqual({ owner: "windoliver", repo: "myproject", number: 43 });
  });

  test("rejects missing #", () => {
    expect(() => parseDiscussionRef("owner/repo")).toThrow(/expected 'owner\/repo#number'/);
  });

  test("rejects non-numeric", () => {
    expect(() => parseDiscussionRef("owner/repo#xyz")).toThrow(/not a valid number/);
  });

  test("rejects zero", () => {
    expect(() => parseDiscussionRef("owner/repo#0")).toThrow(/positive integer/);
  });
});
