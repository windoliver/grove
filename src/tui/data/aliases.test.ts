import { describe, expect, test } from "bun:test";
import { DEFAULT_ALIASES, MAX_ALIAS_DEPTH, resolveAlias } from "./aliases.js";

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
