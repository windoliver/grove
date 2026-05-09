import { describe, expect, test } from "bun:test";
import {
  type AliasMap,
  DEFAULT_ALIASES,
  MAX_ALIAS_DEPTH,
  matchAliases,
  resolveAlias,
} from "./aliases.js";

describe("DEFAULT_ALIASES", () => {
  test("contains six built-in keys", () => {
    expect([...DEFAULT_ALIASES.keys()].sort()).toEqual(["a", "d", "q", "r", "s", "t"]);
  });

  test("maps to expected commands", () => {
    expect(DEFAULT_ALIASES.get("a")?.value).toBe("agents");
    expect(DEFAULT_ALIASES.get("s")?.value).toBe("sessions");
    expect(DEFAULT_ALIASES.get("t")?.value).toBe("tasks");
    expect(DEFAULT_ALIASES.get("d")?.value).toBe("dag");
    expect(DEFAULT_ALIASES.get("r")?.value).toBe("reviews");
    expect(DEFAULT_ALIASES.get("q")?.value).toBe("quit");
  });

  test("MAX_ALIAS_DEPTH is 8", () => {
    expect(MAX_ALIAS_DEPTH).toBe(8);
  });
});

describe("resolveAlias direct + miss", () => {
  test("direct match returns ok with command and empty argv", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "a");
    expect(r).toEqual({ kind: "ok", command: "agents", argv: [], chain: ["a"] });
  });

  test("unknown key at depth 0 returns miss", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "zzz");
    expect(r).toEqual({ kind: "miss", key: "zzz" });
  });

  test("empty input returns miss with empty key", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "");
    expect(r).toEqual({ kind: "miss", key: "" });
  });

  test("whitespace-only input returns miss", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "   ");
    expect(r).toEqual({ kind: "miss", key: "" });
  });
});

describe("resolveAlias recursion + argv", () => {
  function withCustom(extra: Record<string, string>): AliasMap {
    const m = new Map(DEFAULT_ALIASES);
    for (const [k, v] of Object.entries(extra)) m.set(k, { value: v });
    return m;
  }

  test("alias chains to another alias", () => {
    const m = withCustom({ dev: ":a" });
    const r = resolveAlias(m, "dev");
    expect(r).toEqual({ kind: "ok", command: "agents", argv: [], chain: ["dev", "a"] });
  });

  test("argv from input passes through", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "a foo bar");
    expect(r).toEqual({
      kind: "ok",
      command: "agents",
      argv: ["foo", "bar"],
      chain: ["a"],
    });
  });

  test("argv from alias value merges with input argv", () => {
    const m = withCustom({ prod: ":a foo" });
    const r = resolveAlias(m, "prod bar");
    expect(r).toEqual({
      kind: "ok",
      command: "agents",
      argv: ["foo", "bar"],
      chain: ["prod", "a"],
    });
  });

  test("terminal alias with multi-word value", () => {
    const m = withCustom({ hello: "echo hi" });
    const r = resolveAlias(m, "hello there");
    expect(r).toEqual({
      kind: "ok",
      command: "echo",
      argv: ["hi", "there"],
      chain: ["hello"],
    });
  });
});

describe("resolveAlias cycle + depth", () => {
  test("self-cycle returns cycle result", () => {
    const m = new Map(DEFAULT_ALIASES);
    m.set("loop", { value: ":loop" });
    const r = resolveAlias(m, "loop");
    expect(r.kind).toBe("cycle");
    if (r.kind === "cycle") expect(r.chain).toEqual(["loop", "loop"]);
  });

  test("two-step cycle returns cycle result", () => {
    const m = new Map(DEFAULT_ALIASES);
    m.set("x", { value: ":y" });
    m.set("y", { value: ":x" });
    const r = resolveAlias(m, "x");
    expect(r.kind).toBe("cycle");
    if (r.kind === "cycle") expect(r.chain).toEqual(["x", "y", "x"]);
  });

  test("8-hop chain succeeds", () => {
    const m = new Map(DEFAULT_ALIASES);
    // h0 → h1 → ... → h7 → "a" (8 hops total)
    for (let i = 0; i < 8; i++) m.set(`h${i}`, { value: i === 7 ? ":a" : `:h${i + 1}` });
    const r = resolveAlias(m, "h0");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.command).toBe("agents");
  });

  test("9-hop chain returns depth error", () => {
    const m = new Map(DEFAULT_ALIASES);
    for (let i = 0; i < 9; i++) m.set(`h${i}`, { value: i === 8 ? ":a" : `:h${i + 1}` });
    const r = resolveAlias(m, "h0");
    expect(r.kind).toBe("depth");
  });
});

describe("matchAliases", () => {
  test("empty prefix returns all keys sorted", () => {
    expect(matchAliases(DEFAULT_ALIASES, "")).toEqual(["a", "d", "q", "r", "s", "t"]);
  });

  test("single-char prefix narrows to matches", () => {
    const m = new Map(DEFAULT_ALIASES);
    m.set("agents-only", { value: "agents" });
    m.set("admin", { value: ":a" });
    expect(matchAliases(m, "a")).toEqual(["a", "admin", "agents-only"]);
  });

  test("no matches returns empty array", () => {
    expect(matchAliases(DEFAULT_ALIASES, "zz")).toEqual([]);
  });

  test("case-insensitive match", () => {
    expect(matchAliases(DEFAULT_ALIASES, "A")).toEqual(["a"]);
  });
});
