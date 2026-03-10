/**
 * Tests for `grove ask` CLI command.
 */

import { describe, expect, test } from "bun:test";
import { executeAsk, parseAskArgs } from "./ask.js";

describe("parseAskArgs", () => {
  test("parses question from positional", () => {
    const opts = parseAskArgs(["What should I do?"]);
    expect(opts.question).toBe("What should I do?");
    expect(opts.options).toEqual([]);
    expect(opts.context).toBeUndefined();
    expect(opts.strategy).toBeUndefined();
  });

  test("parses --options as comma-separated list", () => {
    const opts = parseAskArgs(["Pick one", "--options", "foo,bar,baz"]);
    expect(opts.options).toEqual(["foo", "bar", "baz"]);
  });

  test("parses --context", () => {
    const opts = parseAskArgs(["Question", "--context", "We need speed"]);
    expect(opts.context).toBe("We need speed");
  });

  test("parses --strategy", () => {
    const opts = parseAskArgs(["Question", "--strategy", "rules"]);
    expect(opts.strategy).toBe("rules");
  });

  test("parses --config", () => {
    const opts = parseAskArgs(["Question", "--config", "/tmp/config.json"]);
    expect(opts.config).toBe("/tmp/config.json");
  });

  test("throws on missing question", () => {
    expect(() => parseAskArgs([])).toThrow("Usage:");
  });

  test("throws on invalid strategy", () => {
    expect(() => parseAskArgs(["Q", "--strategy", "bogus"])).toThrow("Invalid strategy");
  });

  test("accepts all valid strategy names", () => {
    for (const s of ["llm", "rules", "agent", "interactive"] as const) {
      const opts = parseAskArgs(["Q", "--strategy", s]);
      expect(opts.strategy).toBe(s);
    }
  });
});

describe("executeAsk", () => {
  test("returns answer using rules strategy", async () => {
    const answer = await executeAsk({
      question: "Pick one",
      options: ["Alpha", "Beta"],
      context: undefined,
      strategy: "rules",
      config: undefined,
    });
    // Rules strategy with default prefer=simpler picks the shorter option
    expect(answer).toBe("Beta");
  });

  test("returns default response for question without options", async () => {
    const answer = await executeAsk({
      question: "What should I do?",
      options: [],
      context: undefined,
      strategy: "rules",
      config: undefined,
    });
    expect(answer).toBe("Proceed with the simpler, more conventional approach.");
  });
});
